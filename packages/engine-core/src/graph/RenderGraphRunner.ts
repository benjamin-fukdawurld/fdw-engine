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
  PassContext,
  RenderGraph,
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

/**
 * Executes render graphs, frame after frame: compiles them (with a cache by
 * structure), allocates their transient resources from a pool reused between
 * frames, records their passes and submits them.
 */
export class RenderGraphRunner {
  private readonly _compiled = new Map<string, CompiledRenderGraph>();
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
    options: RenderGraphRunnerOptions = {}
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
    return this._passTimes;
  }

  /**
   * Compiles (or finds in the cache) and runs a graph. `size` is the size of
   * the frame, for the textures of relative size; it defaults to the size of
   * the first imported texture.
   */
  execute(
    graph: RenderGraph,
    options: { size?: { width: number; height: number } } = {}
  ): CompiledRenderGraph {
    const compiled = this.compile(graph);
    const size = options.size ?? this.frameSize(graph);
    const real = new Map<number, GraphResource>();
    const keys = new Map<number, string>();
    for (const resource of graph.resources) {
      if (resource.imported) {
        real.set(resource.id, resource.imported);
      }
    }
    const byName = new Map(
      graph.resources.map((resource) => [resource.name, resource.id])
    );

    const encoder = this.backend.createCommandEncoder();
    const timer = this.timer(graph);
    const timed: string[] = [];
    // The measure of a pass, when the frame is timed.
    const timing = (name: string): PassTiming | undefined => {
      if (!timer) {
        return undefined;
      }
      timed.push(name);
      return { timer, index: timed.length - 1 };
    };
    compiled.order.forEach((index, position) => {
      const pass = graph.passes[index];

      // Resources whose lifetime starts here: from the pool, possibly
      // released by an earlier pass of this frame.
      for (const id of compiled.acquires[position]) {
        const usages = compiled.lifetimes.get(id)?.usages ?? new Set();
        const key = this.poolKey(graph, id, usages, size);
        real.set(id, this.acquire(graph, id, key, usages, size));
        keys.set(id, key);
      }

      const transitions = compiled.transitions[position];
      if (transitions.length > 0 && encoder.transition) {
        encoder.transition(
          transitions.map(
            (transition): ResourceTransition => ({
              resource: real.get(
                byName.get(transition.resource) as number
              ) as GraphResource,
              from: transition.from,
              to: transition.to,
            })
          )
        );
      }

      const declared = new Set(pass.accesses.map((access) => access.resource));
      const lookup = (handle: TextureHandle | BufferHandle) => {
        if (!declared.has(handle.resource)) {
          throw new Error(
            `Pass "${pass.name}" uses "${handle.name}" without declaring it`
          );
        }
        return real.get(handle.resource) as GraphResource;
      };
      const base: PassContext = {
        backend: this.backend,
        texture: (handle) => lookup(handle) as GpuAttachmentTarget,
        buffer: (handle) => lookup(handle) as GpuBuffer,
        size: (handle) => {
          const target = lookup(handle) as {
            width?: number;
            height?: number;
            dimensions?: { width: number; height?: number };
          };
          return {
            width: target.width ?? target.dimensions?.width ?? 1,
            height: target.height ?? target.dimensions?.height ?? 1,
          };
        },
      };
      const execute = pass.execute as unknown as (context: object) => void;

      if (pass.kind === 'raster') {
        const renderPass = encoder.beginRenderPass({
          label: pass.name,
          colorAttachments: pass.colors.map(
            (color): RenderPassColorAttachment => ({
              target: real.get(color.resource) as GpuAttachmentTarget,
              load: color.load,
              ...(color.resolve !== undefined
                ? {
                    resolveTarget: real.get(
                      color.resolve
                    ) as GpuAttachmentTarget,
                  }
                : {}),
              ...(color.clearValue !== undefined
                ? { clearValue: color.clearValue as never }
                : {}),
            })
          ),
          ...(pass.depth
            ? {
                depthAttachment: {
                  target: real.get(pass.depth.resource) as GpuAttachmentTarget,
                  load: pass.depth.load,
                  clearValue: pass.depth.clearValue as number | undefined,
                },
              }
            : {}),
          timing: timing(pass.name),
        });
        execute({ ...base, pass: renderPass });
        renderPass.end();
      } else if (pass.kind === 'compute') {
        const computePass = encoder.beginComputePass(
          pass.name,
          timing(pass.name)
        );
        execute({ ...base, pass: computePass });
        computePass.end();
      } else {
        execute({ ...base, encoder });
      }

      // Resources whose lifetime ends here: back to the pool, where a later
      // pass of the frame can take them (the commands run in order), as
      // well as the next frames.
      for (const id of compiled.releases[position]) {
        this.release(keys.get(id) as string, real.get(id) as PooledResource);
      }
    });
    if (timer) {
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
    this._compiled.clear();
  }

  // The timer of a frame, large enough for the passes of the graph; none
  // without the timing option, or where the backend cannot measure.
  private timer(graph: RenderGraph): GpuPassTimer | undefined {
    if (!this._timing || !this.backend.createPassTimer) {
      return undefined;
    }
    const passes = graph.passes.filter(
      (pass) => pass.kind === 'raster' || pass.kind === 'compute'
    ).length;
    if (!this._timer || this._timer.capacity < passes) {
      // Larger: the measures in flight are lost.
      this._timer?.destroy();
      this._timedPasses.clear();
      this._timer = this.backend.createPassTimer(Math.max(passes, 16));
    }
    return this._timer;
  }

  private compile(graph: RenderGraph): CompiledRenderGraph {
    const key = graph.structuralKey();
    let compiled = this._compiled.get(key);
    if (compiled) {
      // Most recently used last.
      this._compiled.delete(key);
    } else {
      compiled = graph.compile();
      this.compilations++;
      if (this._compiled.size >= this._cacheSize) {
        this._compiled.delete(this._compiled.keys().next().value as string);
      }
    }
    this._compiled.set(key, compiled);
    return compiled;
  }

  private frameSize(graph: RenderGraph): { width: number; height: number } {
    for (const resource of graph.resources) {
      const target = resource.imported as
        | {
            width?: number;
            height?: number;
            dimensions?: { width: number; height?: number };
          }
        | undefined;
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
    frame: { width: number; height: number }
  ): { width: number; height: number } {
    const size = graph.resources[id].texture?.size ?? { relative: 1 };
    return 'relative' in size
      ? {
          width: Math.max(1, Math.round(frame.width * size.relative)),
          height: Math.max(1, Math.round(frame.height * size.relative)),
        }
      : size;
  }

  private poolKey(
    graph: RenderGraph,
    id: number,
    usages: ReadonlySet<ResourceUsage>,
    frame: { width: number; height: number }
  ): string {
    const resource = graph.resources[id];
    const sorted = [...usages].sort();
    return resource.kind === 'texture'
      ? JSON.stringify([
          'texture',
          resource.texture?.format,
          this.textureSize(graph, id, frame),
          resource.texture?.sampleCount ?? 1,
          sorted,
        ])
      : JSON.stringify(['buffer', resource.buffer?.size, sorted]);
  }

  private acquire(
    graph: RenderGraph,
    id: number,
    key: string,
    usages: ReadonlySet<ResourceUsage>,
    frame: { width: number; height: number }
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
        usage: [
          ...new Set(
            [...usages]
              .map((usage) => textureUsages[usage])
              .filter((usage): usage is GpuTextureUsage => usage !== undefined)
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
            .filter((usage): usage is GpuBufferUsage => usage !== undefined)
        ),
      ],
    });
  }

  private release(key: string, resource: PooledResource): void {
    const free = this._free.get(key) ?? [];
    free.push({ resource, lastUsed: this._frame });
    this._free.set(key, free);
  }

  // Destroys the free resources not reused for a few frames.
  private endFrame(): void {
    this._frame++;
    for (const [key, entries] of this._free) {
      const kept = entries.filter((entry) => {
        if (this._frame - entry.lastUsed > this._keepFrames) {
          entry.resource.destroy();
          return false;
        }
        return true;
      });
      if (kept.length > 0) {
        this._free.set(key, kept);
      } else {
        this._free.delete(key);
      }
    }
  }
}
