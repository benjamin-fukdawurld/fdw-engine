import { fullMipLevelCount } from '@fdw/engine-backend';
import type {
  GpuAttachmentTarget,
  GpuBuffer,
  GpuBufferUsage,
  GpuPassTimer,
  GpuTexture,
  GpuTextureUsage,
  RenderBackend,
  PassTiming,
  RenderPassColorAttachment,
  ResourceTransition,
  ResourceUsage,
} from '@fdw/engine-backend';
import type {
  BufferHandle,
  CompiledRenderGraph,
  RenderGraph,
  ShapeValue,
  TextureHandle,
} from './RenderGraph';

const textureUsages: Partial<Record<ResourceUsage, GpuTextureUsage>> = {
  'color-attachment': 'render-attachment',
  'depth-attachment': 'render-attachment',
  'depth-read': 'render-attachment',
  sampled: 'sampled',
  'storage-read': 'storage',
  'storage-write': 'storage',
  'copy-src': 'copy-src',
  'copy-dst': 'copy-dst',
};

const bufferUsages: Partial<Record<ResourceUsage, GpuBufferUsage>> = {
  uniform: 'uniform',
  'storage-read': 'storage',
  'storage-write': 'storage',
  vertex: 'vertex',
  index: 'index',
  indirect: 'indirect',
  'copy-src': 'copy-src',
  'copy-dst': 'copy-dst',
};

// A resource of a frame: imported, or a pooled texture or buffer.
type GraphResource = GpuAttachmentTarget | GpuBuffer;
type PooledResource = GpuTexture | GpuBuffer;

interface PoolEntry {
  readonly resource: PooledResource;
  lastUsed: number;
}

// A compiled graph in the cache, with what the runner derives from it once:
// the graphs of its shape have the same resources, descriptors and usages.
interface CachedGraph {
  readonly shape: readonly ShapeValue[];
  readonly compiled: CompiledRenderGraph;
  // The resource of each transition, by position.
  readonly transitionIds: readonly (readonly number[])[];
  // The pool key of each transient resource, by id, for the frame size
  // they were computed with.
  readonly poolKeys: string[];
  width: number;
  height: number;
}

type TextureTarget = {
  width?: number;
  height?: number;
  dimensions?: { width: number; height?: number };
};

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

const noUsages: ReadonlySet<ResourceUsage> = new Set();

export interface RenderGraphRunnerOptions {
  // Frames a free transient resource is kept before being destroyed.
  readonly keepFrames?: number;
  // Compiled graphs kept in the cache.
  readonly cacheSize?: number;
  // Measures the GPU duration of the render and compute passes, where the
  // backend can (see passTimes). Default false.
  readonly timing?: boolean;
}

// The frames whose pass names are kept, waiting for their measures.
const TimedFrames = 8;

// Whether two shapes are equal: the graphs have the same structure.
function sameShape(
  a: readonly ShapeValue[],
  b: readonly ShapeValue[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// Whether a pass declares a resource.
function declares(
  accesses: readonly { readonly resource: number }[],
  resource: number,
): boolean {
  for (const access of accesses) {
    if (access.resource === resource) {
      return true;
    }
  }
  return false;
}

/**
 * Executes render graphs, frame after frame: compiles them (with a cache by
 * structure), allocates their transient resources from a pool reused between
 * frames, records their passes and submits them.
 */
export class RenderGraphRunner {
  // The compiled graphs, most recently used last.
  private readonly _compiled: CachedGraph[] = [];
  // The shape of the graph being executed: reused from frame to frame.
  private readonly _shape: ShapeValue[] = [];
  private readonly _free = new Map<string, PoolEntry[]>();
  private readonly _keepFrames: number;
  private readonly _cacheSize: number;
  private _frame = 0;
  private readonly _timing: boolean;
  private _timer?: GpuPassTimer;
  // The names of the measured passes of the recent frames, by slot.
  private readonly _timedPasses = new Map<number, string[]>();
  private _passTimes = new Map<string, number>();
  // Statistics, for tests and diagnostics.
  compilations = 0;
  created = 0;

  constructor(
    readonly backend: RenderBackend,
    options: RenderGraphRunnerOptions = {},
  ) {
    this._keepFrames = options.keepFrames ?? 3;
    this._cacheSize = options.cacheSize ?? 16;
    this._timing = options.timing ?? false;
  }

  /**
   * The GPU durations of the passes of a recent frame, in milliseconds, by
   * pass name, with the `timing` option. The GPU answers a few frames late:
   * empty at first, and where the backend cannot measure.
   */
  get passTimes(): ReadonlyMap<string, number> {
    this.readTimes();
    return this._passTimes;
  }

  // The measures arrived, read at each frame too: a timer takes new ones
  // once the previous are read (Vulkan), and the names of the passes of a
  // frame are only kept a few frames.
  private readTimes(): void {
    const times = this._timer?.read();
    const names = times && this._timedPasses.get(times.frame);
    if (times && names) {
      const result = new Map<string, number>();
      names.forEach((name, slot) => {
        const duration = times.durations[slot];
        if (!Number.isNaN(duration)) {
          // Two passes of the same name: their sum.
          result.set(name, (result.get(name) ?? 0) + duration);
        }
      });
      this._passTimes = result;
    }
  }

  /**
   * Compiles (or finds in the cache) and runs a graph. `size` is the size of
   * the frame, for the textures of relative size; it defaults to the size
   * the graph was created with, else to the size of the first imported
   * texture.
   */
  execute(
    graph: RenderGraph,
    options: { size?: { width: number; height: number } } = {},
  ): CompiledRenderGraph {
    const cached = this.compile(graph);
    const compiled = cached.compiled;
    const size = options.size ?? graph.size ?? this.frameSize(graph);
    const poolKeys = this.poolKeys(graph, cached, size);
    // The resources of the frame, by id.
    const real: (GraphResource | undefined)[] = [];
    for (const resource of graph.resources) {
      real[resource.id] = resource.imported;
    }

    const encoder = this.backend.createCommandEncoder();
    this.readTimes();
    const timer = this.timer(graph);
    const timed: string[] | undefined = timer ? [] : undefined;
    for (let position = 0; position < compiled.order.length; position++) {
      const pass = graph.passes[compiled.order[position]];

      // Resources whose lifetime starts here: from the pool, possibly
      // released by an earlier pass of this frame.
      for (const id of compiled.acquires[position]) {
        const usages = compiled.lifetimes.get(id)?.usages ?? noUsages;
        real[id] = this.acquire(graph, id, poolKeys[id], usages, size);
      }

      const transitions = compiled.transitions[position];
      if (transitions.length > 0 && encoder.transition) {
        const ids = cached.transitionIds[position];
        encoder.transition(
          transitions.map((transition, i): ResourceTransition => ({
            resource: real[ids[i]] as GraphResource,
            from: transition.from,
            to: transition.to,
          })),
        );
      }

      const lookup = (handle: TextureHandle | BufferHandle) => {
        if (!declares(pass.accesses, handle.resource)) {
          throw new Error(
            `Pass "${pass.name}" uses "${handle.name}" without declaring it`,
          );
        }
        return real[handle.resource] as GraphResource;
      };
      const texture = (handle: TextureHandle) =>
        lookup(handle) as GpuAttachmentTarget;
      const buffer = (handle: BufferHandle) => lookup(handle) as GpuBuffer;
      const sizeOf = (handle: TextureHandle) => {
        const target = lookup(handle) as TextureTarget;
        return {
          width: target.width ?? target.dimensions?.width ?? 1,
          height: target.height ?? target.dimensions?.height ?? 1,
        };
      };
      const execute = pass.execute as unknown as (context: object) => void;
      // The measure of the pass, when the frame is timed.
      const timing: PassTiming | undefined =
        timer && timed && pass.kind !== 'copy'
          ? { timer, index: timed.push(pass.name) - 1 }
          : undefined;

      if (pass.kind === 'raster') {
        const colorAttachments: RenderPassColorAttachment[] = [];
        for (const color of pass.colors) {
          const attachment: Mutable<RenderPassColorAttachment> = {
            target: real[color.resource] as GpuAttachmentTarget,
            load: color.load,
          };
          if (color.resolve !== undefined) {
            attachment.resolveTarget = real[
              color.resolve
            ] as GpuAttachmentTarget;
          }
          if (color.clearValue !== undefined) {
            attachment.clearValue = color.clearValue as never;
          }
          colorAttachments.push(attachment);
        }
        const renderPass = encoder.beginRenderPass(
          pass.depth
            ? {
                label: pass.name,
                colorAttachments,
                depthAttachment: {
                  target: real[pass.depth.resource] as GpuAttachmentTarget,
                  load: pass.depth.load,
                  clearValue: pass.depth.clearValue as number | undefined,
                },
                timing,
              }
            : { label: pass.name, colorAttachments, timing },
        );
        execute({
          backend: this.backend,
          texture,
          buffer,
          size: sizeOf,
          pass: renderPass,
        });
        renderPass.end();
      } else if (pass.kind === 'compute') {
        const computePass = encoder.beginComputePass(pass.name, timing);
        execute({
          backend: this.backend,
          texture,
          buffer,
          size: sizeOf,
          pass: computePass,
        });
        computePass.end();
      } else {
        execute({
          backend: this.backend,
          texture,
          buffer,
          size: sizeOf,
          encoder,
        });
      }

      // Resources whose lifetime ends here: back to the pool, where a later
      // pass of the frame can take them (the commands run in order), as
      // well as the next frames.
      for (const id of compiled.releases[position]) {
        this.release(poolKeys[id], real[id] as PooledResource);
      }
    }
    if (timer && timed) {
      timer.resolve(encoder, this._frame);
      this._timedPasses.set(this._frame, timed);
      this._timedPasses.delete(this._frame - TimedFrames);
    }
    this.backend.submit([encoder.finish()]);
    this.endFrame();
    return compiled;
  }

  /** Destroys the pooled resources. */
  destroy(): void {
    this._timer?.destroy();
    this._timer = undefined;
    for (const entries of this._free.values()) {
      for (const entry of entries) {
        entry.resource.destroy();
      }
    }
    this._free.clear();
    this._compiled.length = 0;
  }

  // The timer of a frame, large enough for the passes of the graph; none
  // without the timing option, or where the backend cannot measure.
  private timer(graph: RenderGraph): GpuPassTimer | undefined {
    if (!this._timing || !this.backend.createPassTimer) {
      return undefined;
    }
    let passes = 0;
    for (const pass of graph.passes) {
      if (pass.kind === 'raster' || pass.kind === 'compute') {
        passes++;
      }
    }
    if (!this._timer || this._timer.capacity < passes) {
      // Larger: the measures in flight are lost.
      this._timer?.destroy();
      this._timedPasses.clear();
      this._timer = this.backend.createPassTimer(Math.max(passes, 16));
    }
    return this._timer;
  }

  // The compilation of a graph: found in the cache by its shape (graphs of
  // the same structure), the most recent first, or compiled.
  private compile(graph: RenderGraph): CachedGraph {
    const shape = this._shape;
    shape.length = 0;
    graph.writeShape(shape);
    const cache = this._compiled;
    for (let i = cache.length - 1; i >= 0; i--) {
      const cached = cache[i];
      if (sameShape(cached.shape, shape)) {
        if (i !== cache.length - 1) {
          cache.splice(i, 1);
          cache.push(cached);
        }
        return cached;
      }
    }
    const compiled = graph.compile();
    this.compilations++;
    const ids = new Map(
      graph.resources.map((resource) => [resource.name, resource.id]),
    );
    const cached: CachedGraph = {
      shape: shape.slice(),
      compiled,
      transitionIds: compiled.transitions.map((transitions) =>
        transitions.map((transition) => ids.get(transition.resource) as number),
      ),
      poolKeys: [],
      width: 0,
      height: 0,
    };
    if (cache.length >= this._cacheSize) {
      cache.shift();
    }
    cache.push(cached);
    return cached;
  }

  // The pool keys of the transient resources of a graph: computed again
  // when the size of the frame changes (relative sizes, full mip chains).
  private poolKeys(
    graph: RenderGraph,
    cached: CachedGraph,
    frame: { width: number; height: number },
  ): readonly string[] {
    if (
      cached.poolKeys.length === 0 ||
      cached.width !== frame.width ||
      cached.height !== frame.height
    ) {
      cached.poolKeys.length = 0;
      for (const [id, { usages }] of cached.compiled.lifetimes) {
        cached.poolKeys[id] = this.poolKey(graph, id, usages, frame);
      }
      cached.width = frame.width;
      cached.height = frame.height;
    }
    return cached.poolKeys;
  }

  private frameSize(graph: RenderGraph): { width: number; height: number } {
    for (const resource of graph.resources) {
      const target = resource.imported as TextureTarget | undefined;
      if (resource.kind === 'texture' && target) {
        return {
          width: target.width ?? target.dimensions?.width ?? 1,
          height: target.height ?? target.dimensions?.height ?? 1,
        };
      }
    }
    return { width: 1, height: 1 };
  }

  private textureSize(
    graph: RenderGraph,
    id: number,
    frame: { width: number; height: number },
  ): { width: number; height: number } {
    const size = graph.resources[id].texture?.size ?? { relative: 1 };
    return 'relative' in size
      ? {
          width: Math.max(1, Math.round(frame.width * size.relative)),
          height: Math.max(1, Math.round(frame.height * size.relative)),
        }
      : size;
  }

  private mipLevelCount(
    graph: RenderGraph,
    id: number,
    frame: { width: number; height: number },
  ): number {
    const count = graph.resources[id].texture?.mipLevelCount ?? 1;
    return count === 'full'
      ? fullMipLevelCount(this.textureSize(graph, id, frame))
      : count;
  }

  private poolKey(
    graph: RenderGraph,
    id: number,
    usages: ReadonlySet<ResourceUsage>,
    frame: { width: number; height: number },
  ): string {
    const resource = graph.resources[id];
    const sorted = [...usages].sort();
    return resource.kind === 'texture'
      ? JSON.stringify([
          'texture',
          resource.texture?.format,
          this.textureSize(graph, id, frame),
          resource.texture?.sampleCount ?? 1,
          this.mipLevelCount(graph, id, frame),
          sorted,
        ])
      : JSON.stringify(['buffer', resource.buffer?.size, sorted]);
  }

  private acquire(
    graph: RenderGraph,
    id: number,
    key: string,
    usages: ReadonlySet<ResourceUsage>,
    frame: { width: number; height: number },
  ): PooledResource {
    const free = this._free.get(key);
    const entry = free?.pop();
    if (entry) {
      return entry.resource;
    }
    this.created++;
    const resource = graph.resources[id];
    if (resource.kind === 'texture') {
      const { width, height } = this.textureSize(graph, id, frame);
      return this.backend.textures.createTexture({
        label: resource.texture?.label ?? resource.name,
        type: '2d',
        format: resource.texture?.format as string,
        dimensions: { width, height },
        ...(resource.texture?.sampleCount
          ? { sampleCount: resource.texture.sampleCount }
          : {}),
        mipLevelCount: this.mipLevelCount(graph, id, frame),
        usage: [
          ...new Set(
            [...usages]
              .map((usage) => textureUsages[usage])
              .filter((usage): usage is GpuTextureUsage => usage !== undefined),
          ),
        ],
      });
    }
    return this.backend.buffers.create({
      label: resource.buffer?.label ?? resource.name,
      size: resource.buffer?.size as number,
      usage: [
        ...new Set(
          [...usages]
            .map((usage) => bufferUsages[usage])
            .filter((usage): usage is GpuBufferUsage => usage !== undefined),
        ),
      ],
    });
  }

  private release(key: string, resource: PooledResource): void {
    let free = this._free.get(key);
    if (!free) {
      free = [];
      this._free.set(key, free);
    }
    free.push({ resource, lastUsed: this._frame });
  }

  // Destroys the free resources not reused for a few frames.
  private endFrame(): void {
    this._frame++;
    for (const [key, entries] of this._free) {
      // Compacted in place: the entries kept, in order.
      let kept = 0;
      for (const entry of entries) {
        if (this._frame - entry.lastUsed > this._keepFrames) {
          entry.resource.destroy();
        } else {
          entries[kept++] = entry;
        }
      }
      entries.length = kept;
      if (kept === 0) {
        this._free.delete(key);
      }
    }
  }
}
