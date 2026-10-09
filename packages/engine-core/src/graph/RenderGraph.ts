import type {
  GpuAttachmentTarget,
  GpuBuffer,
  GpuCommandEncoder,
  GpuComputePassEncoder,
  GpuRenderPassEncoder,
  GpuTextureFormat,
  IColor,
  RenderBackend,
  ResourceUsage,
} from '@fdw/engine-backend';

// A frame described as passes that declare the resources (textures,
// buffers) they read and write. Compiling the graph culls the passes whose
// results are not used, orders the others, computes the lifetimes and the
// usages of the transient resources, and the transitions between usages for
// the backends with explicit synchronization. See design/render-graph.md.

/** A version of a resource of the graph: each write creates a new one. */
export interface ResourceHandle<K extends 'texture' | 'buffer'> {
  readonly kind: K;
  readonly resource: number;
  readonly version: number;
  readonly name: string;
}

export type TextureHandle = ResourceHandle<'texture'>;
export type BufferHandle = ResourceHandle<'buffer'>;
type AnyHandle = TextureHandle | BufferHandle;

export type TextureSize =
  | { readonly width: number; readonly height: number }
  // Relative to the size of the frame: 1 for full resolution, 0.5 for half…
  | { readonly relative: number };

export interface GraphTextureDescriptor {
  readonly format: GpuTextureFormat;
  // Defaults to the size of the frame.
  readonly size?: TextureSize;
  readonly label?: string;
}

export interface GraphBufferDescriptor {
  readonly size: number;
  readonly label?: string;
}

export type PassKind = 'raster' | 'compute' | 'copy';

type ReadUsage = Extract<
  ResourceUsage,
  | 'sampled'
  | 'storage-read'
  | 'uniform'
  | 'vertex'
  | 'index'
  | 'indirect'
  | 'copy-src'
  | 'depth-read'
>;
type WriteUsage = Extract<
  ResourceUsage,
  'storage-write' | 'copy-dst' | 'color-attachment' | 'depth-attachment'
>;

interface ResourceNode {
  readonly id: number;
  readonly name: string;
  readonly kind: 'texture' | 'buffer';
  readonly texture?: GraphTextureDescriptor;
  readonly buffer?: GraphBufferDescriptor;
  readonly imported?: GpuAttachmentTarget | GpuBuffer;
  latest: number;
}

interface Access {
  readonly resource: number;
  readonly version: number;
  readonly usage: ResourceUsage;
  readonly write: boolean;
  // A write that replaces the whole content (a cleared attachment): it does
  // not depend on the previous version.
  readonly discards: boolean;
}

interface Attachment {
  readonly resource: number;
  readonly load: 'clear' | 'load';
  readonly clearValue?: IColor | number;
}

interface PassNode {
  readonly index: number;
  readonly name: string;
  readonly kind: PassKind;
  readonly accesses: Access[];
  readonly colors: Attachment[];
  depth?: Attachment;
  sideEffects: boolean;
  execute?: (context: never) => void;
}

/** What every pass context gives: the real resources of the handles. */
export interface PassContext {
  readonly backend: RenderBackend;
  // The texture or render target of a handle declared by the pass.
  texture(handle: TextureHandle): GpuAttachmentTarget;
  // The buffer of a handle declared by the pass.
  buffer(handle: BufferHandle): GpuBuffer;
}

export interface RasterPassContext extends PassContext {
  readonly pass: GpuRenderPassEncoder;
}

export interface ComputePassContext extends PassContext {
  readonly pass: GpuComputePassEncoder;
}

export interface CopyPassContext extends PassContext {
  readonly encoder: GpuCommandEncoder;
}

/** Declares the resources of a pass. */
export class PassBuilder {
  constructor(
    protected readonly _graph: RenderGraph,
    protected readonly _pass: PassNode
  ) {}

  /** Reads a version of a resource. */
  read<H extends AnyHandle>(handle: H, usage: ReadUsage): H {
    this._graph.access(this._pass, handle, usage, false, false);
    return handle;
  }

  /**
   * Writes the latest version of a resource; returns the new version. A
   * partial write: the new version depends on the previous one.
   */
  write<H extends AnyHandle>(handle: H, usage: WriteUsage): H {
    return this._graph.access(this._pass, handle, usage, true, false) as H;
  }

  /** The pass runs even when no other pass reads what it writes. */
  hasSideEffects(): void {
    this._pass.sideEffects = true;
  }
}

/** Declares the attachments and resources of a render pass. */
export class RasterPassBuilder extends PassBuilder {
  writeColor(
    handle: TextureHandle,
    { load, clearValue }: { load: 'clear' | 'load'; clearValue?: IColor }
  ): TextureHandle {
    const written = this._graph.access(
      this._pass,
      handle,
      'color-attachment',
      true,
      load === 'clear'
    ) as TextureHandle;
    this._pass.colors.push({ resource: handle.resource, load, clearValue });
    return written;
  }

  writeDepth(
    handle: TextureHandle,
    { load, clearValue = 1 }: { load: 'clear' | 'load'; clearValue?: number }
  ): TextureHandle {
    this.setDepth(handle, load, clearValue);
    return this._graph.access(
      this._pass,
      handle,
      'depth-attachment',
      true,
      load === 'clear'
    ) as TextureHandle;
  }

  /** Depth test without depth writes. */
  readDepth(handle: TextureHandle): TextureHandle {
    this.setDepth(handle, 'load');
    this._graph.access(this._pass, handle, 'depth-read', false, false);
    return handle;
  }

  private setDepth(
    handle: TextureHandle,
    load: 'clear' | 'load',
    clearValue?: number
  ): void {
    if (this._pass.depth) {
      throw new Error(
        `Pass "${this._pass.name}" already has a depth attachment`
      );
    }
    this._pass.depth = { resource: handle.resource, load, clearValue };
  }
}

type PassSetup<C, O> = O & { execute(context: C): void };

/** A transition between two usages of a resource, before a pass. */
export interface CompiledTransition {
  readonly resource: string;
  readonly from: ResourceUsage;
  readonly to: ResourceUsage;
}

/** The result of the compilation of a graph. */
export interface CompiledRenderGraph {
  // The passes kept, in execution order (indices of declaration).
  readonly order: readonly number[];
  readonly culled: readonly string[];
  // Transient resources: first and last pass (positions in order), usages.
  readonly lifetimes: ReadonlyMap<
    number,
    {
      readonly first: number;
      readonly last: number;
      readonly usages: ReadonlySet<ResourceUsage>;
    }
  >;
  // Transitions before each pass of the order, by position.
  readonly transitions: readonly (readonly CompiledTransition[])[];
}

export class RenderGraph {
  private readonly _resources: ResourceNode[] = [];
  private readonly _passes: PassNode[] = [];

  createTexture(
    name: string,
    descriptor: GraphTextureDescriptor
  ): TextureHandle {
    return this.addResource(name, 'texture', { texture: descriptor });
  }

  createBuffer(name: string, descriptor: GraphBufferDescriptor): BufferHandle {
    return this.addResource(name, 'buffer', { buffer: descriptor });
  }

  /**
   * A texture or render target managed outside of the graph (a surface
   * image): writing it is a side effect.
   */
  importTexture(name: string, target: GpuAttachmentTarget): TextureHandle {
    return this.addResource(name, 'texture', { imported: target });
  }

  importBuffer(name: string, buffer: GpuBuffer): BufferHandle {
    return this.addResource(name, 'buffer', { imported: buffer });
  }

  addRasterPass<O extends object>(
    name: string,
    setup: (pass: RasterPassBuilder) => PassSetup<RasterPassContext, O>
  ): O {
    const pass = this.addPass(name, 'raster');
    return this.setupPass(pass, setup(new RasterPassBuilder(this, pass)));
  }

  addComputePass<O extends object>(
    name: string,
    setup: (pass: PassBuilder) => PassSetup<ComputePassContext, O>
  ): O {
    const pass = this.addPass(name, 'compute');
    return this.setupPass(pass, setup(new PassBuilder(this, pass)));
  }

  addCopyPass<O extends object>(
    name: string,
    setup: (pass: PassBuilder) => PassSetup<CopyPassContext, O>
  ): O {
    const pass = this.addPass(name, 'copy');
    return this.setupPass(pass, setup(new PassBuilder(this, pass)));
  }

  /** @internal Records an access of a pass; returns the version written. */
  access(
    pass: PassNode,
    handle: AnyHandle,
    usage: ResourceUsage,
    write: boolean,
    discards: boolean
  ): AnyHandle {
    const resource = this._resources[handle.resource];
    if (!resource || resource.name !== handle.name) {
      throw new Error(`Pass "${pass.name}": unknown resource "${handle.name}"`);
    }
    const previous = pass.accesses.find(
      (access) => access.resource === handle.resource
    );
    // depth-read comes with the depth attachment, declared once.
    if (previous) {
      throw new Error(
        `Pass "${pass.name}" uses "${handle.name}" twice (${previous.usage} and ${usage})`
      );
    }
    if (!write) {
      pass.accesses.push({
        resource: handle.resource,
        version: handle.version,
        usage,
        write,
        discards,
      });
      return handle;
    }
    if (handle.version !== resource.latest) {
      throw new Error(
        `Pass "${pass.name}" writes "${handle.name}" #${handle.version}, already written since: write its latest version (#${resource.latest})`
      );
    }
    resource.latest++;
    pass.accesses.push({
      resource: handle.resource,
      version: resource.latest,
      usage,
      write,
      discards,
    });
    return { ...handle, version: resource.latest };
  }

  /** @internal The declarations, for the runner. */
  get resources(): readonly ResourceNode[] {
    return this._resources;
  }

  /** @internal */
  get passes(): readonly PassNode[] {
    return this._passes;
  }

  /** A key equal for graphs of the same structure: their compilation too. */
  structuralKey(): string {
    return JSON.stringify([
      this._resources.map((resource) => [
        resource.kind,
        resource.name,
        resource.imported ? 'imported' : resource.texture ?? resource.buffer,
      ]),
      this._passes.map((pass) => [
        pass.kind,
        pass.name,
        pass.sideEffects,
        pass.accesses.map((access) => [
          access.resource,
          access.version,
          access.usage,
          access.write,
          access.discards,
        ]),
      ]),
    ]);
  }

  compile(): CompiledRenderGraph {
    const passes = this._passes;
    const key = (resource: number, version: number) => `${resource}:${version}`;
    const producers = new Map<string, number>();
    for (const pass of passes) {
      for (const access of pass.accesses) {
        if (access.write) {
          producers.set(key(access.resource, access.version), pass.index);
        }
      }
    }
    // Reading a transient resource before any write.
    for (const pass of passes) {
      for (const access of pass.accesses) {
        const resource = this._resources[access.resource];
        if (!access.write && !resource.imported && access.version === 0) {
          throw new Error(
            `Pass "${pass.name}" reads "${resource.name}" before any pass writes it`
          );
        }
      }
    }

    // Culling: from the passes with side effects or writing imported
    // resources, up the versions they need.
    const live = new Set<number>();
    const pending = passes
      .filter(
        (pass) =>
          pass.sideEffects ||
          pass.accesses.some(
            (access) =>
              access.write && this._resources[access.resource].imported
          )
      )
      .map((pass) => pass.index);
    while (pending.length > 0) {
      const index = pending.pop() as number;
      if (live.has(index)) {
        continue;
      }
      live.add(index);
      for (const access of passes[index].accesses) {
        const needed = access.write
          ? access.discards
            ? undefined
            : access.version - 1
          : access.version;
        const producer =
          needed === undefined
            ? undefined
            : producers.get(key(access.resource, needed));
        if (producer !== undefined) {
          pending.push(producer);
        }
      }
    }

    // Dependencies between the live passes: read after write, write after
    // write, write after read.
    const dependencies = new Map<number, Set<number>>(
      [...live].map((index) => [index, new Set()])
    );
    const readers = new Map<string, number[]>();
    for (const index of live) {
      for (const access of passes[index].accesses) {
        if (!access.write) {
          const list = readers.get(key(access.resource, access.version)) ?? [];
          list.push(index);
          readers.set(key(access.resource, access.version), list);
        }
      }
    }
    for (const index of live) {
      const depends = dependencies.get(index) as Set<number>;
      for (const access of passes[index].accesses) {
        const version = access.write ? access.version - 1 : access.version;
        const producer = producers.get(key(access.resource, version));
        if (producer !== undefined && live.has(producer)) {
          depends.add(producer);
        }
        if (access.write) {
          for (const reader of readers.get(key(access.resource, version)) ??
            []) {
            if (reader !== index) {
              depends.add(reader);
            }
          }
        }
      }
    }

    // Topological order, in declaration order when free.
    const order: number[] = [];
    const placed = new Set<number>();
    const remaining = [...live].sort((a, b) => a - b);
    while (remaining.length > 0) {
      const next = remaining.findIndex((index) =>
        [...(dependencies.get(index) as Set<number>)].every((d) =>
          placed.has(d)
        )
      );
      if (next < 0) {
        throw new Error(
          `The passes ${remaining
            .map((index) => `"${passes[index].name}"`)
            .join(', ')} depend on each other`
        );
      }
      const [index] = remaining.splice(next, 1);
      order.push(index);
      placed.add(index);
    }

    // Lifetimes and usages of the transient resources; transitions.
    const lifetimes = new Map<
      number,
      { first: number; last: number; usages: Set<ResourceUsage> }
    >();
    const transitions: CompiledTransition[][] = order.map(() => []);
    const current = new Map<number, ResourceUsage>();
    order.forEach((index, position) => {
      for (const access of passes[index].accesses) {
        const resource = this._resources[access.resource];
        if (!resource.imported) {
          const lifetime = lifetimes.get(access.resource) ?? {
            first: position,
            last: position,
            usages: new Set<ResourceUsage>(),
          };
          lifetime.last = position;
          lifetime.usages.add(access.usage);
          lifetimes.set(access.resource, lifetime);
        }
        const from = current.get(access.resource);
        if (from !== undefined && from !== access.usage) {
          transitions[position].push({
            resource: resource.name,
            from,
            to: access.usage,
          });
        }
        current.set(access.resource, access.usage);
      }
    });

    return {
      order,
      culled: passes
        .filter((pass) => !live.has(pass.index))
        .map((pass) => pass.name),
      lifetimes,
      transitions,
    };
  }

  private addResource<K extends 'texture' | 'buffer'>(
    name: string,
    kind: K,
    fields: Pick<ResourceNode, 'texture' | 'buffer' | 'imported'>
  ): ResourceHandle<K> {
    if (this._resources.some((resource) => resource.name === name)) {
      throw new Error(`The graph already has a resource "${name}"`);
    }
    const id = this._resources.length;
    this._resources.push({ id, name, kind, latest: 0, ...fields });
    return { kind, resource: id, version: 0, name };
  }

  private addPass(name: string, kind: PassKind): PassNode {
    if (this._passes.some((pass) => pass.name === name)) {
      throw new Error(`The graph already has a pass "${name}"`);
    }
    const pass: PassNode = {
      index: this._passes.length,
      name,
      kind,
      accesses: [],
      colors: [],
      sideEffects: false,
    };
    this._passes.push(pass);
    return pass;
  }

  private setupPass<C, O extends object>(
    pass: PassNode,
    { execute, ...outputs }: PassSetup<C, O>
  ): O {
    pass.execute = execute as (context: never) => void;
    return outputs as unknown as O;
  }
}
