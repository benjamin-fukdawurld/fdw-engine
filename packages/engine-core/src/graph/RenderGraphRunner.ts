import type {
  GpuAttachmentTarget,
  GpuBuffer,
  GpuBufferUsage,
  GpuTexture,
  GpuTextureUsage,
  RenderBackend,
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
}

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
  // Statistics, for tests and diagnostics.
  compilations = 0;
  created = 0;

  constructor(
    readonly backend: RenderBackend,
    options: RenderGraphRunnerOptions = {}
  ) {
    this._keepFrames = options.keepFrames ?? 3;
    this._cacheSize = options.cacheSize ?? 16;
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
    const allocated: { resource: number; key: string }[] = [];
    for (const resource of graph.resources) {
      if (resource.imported) {
        real.set(resource.id, resource.imported);
      }
    }

    const encoder = this.backend.createCommandEncoder();
    compiled.order.forEach((index, position) => {
      const pass = graph.passes[index];

      // Resources whose lifetime starts here.
      for (const [id, lifetime] of compiled.lifetimes) {
        if (lifetime.first === position) {
          const key = this.poolKey(graph, id, lifetime.usages, size);
          real.set(id, this.acquire(graph, id, key, lifetime.usages, size));
          allocated.push({ resource: id, key });
        }
      }

      const transitions = compiled.transitions[position];
      if (transitions.length > 0 && encoder.transition) {
        encoder.transition(
          transitions.map(
            (transition): ResourceTransition => ({
              resource: real.get(
                graph.resources.findIndex((r) => r.name === transition.resource)
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
      };
      const execute = pass.execute as unknown as (context: object) => void;

      if (pass.kind === 'raster') {
        const renderPass = encoder.beginRenderPass({
          label: pass.name,
          colorAttachments: pass.colors.map(
            (color): RenderPassColorAttachment => ({
              target: real.get(color.resource) as GpuAttachmentTarget,
              load: color.load,
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
        });
        execute({ ...base, pass: renderPass });
        renderPass.end();
      } else if (pass.kind === 'compute') {
        const computePass = encoder.beginComputePass(pass.name);
        execute({ ...base, pass: computePass });
        computePass.end();
      } else {
        execute({ ...base, encoder });
      }
    });
    this.backend.submit([encoder.finish()]);

    // Back to the pool once the frame is recorded: the backends order the
    // next uses after this submission.
    for (const { resource, key } of allocated) {
      this.release(key, real.get(resource) as PooledResource);
    }
    this.endFrame();
    return compiled;
  }

  /** Destroys the pooled resources. */
  destroy(): void {
    for (const entries of this._free.values()) {
      for (const entry of entries) {
        entry.resource.destroy();
      }
    }
    this._free.clear();
    this._compiled.clear();
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
