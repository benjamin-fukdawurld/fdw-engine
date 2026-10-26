import type {
  GpuBindGroupEntry,
  GpuBottomLevel,
  GpuBuffer,
  GpuCommandEncoder,
  GpuTopLevel,
  RenderBackend,
  TopLevelInstance,
} from '@fdw/engine-backend';
import {
  AllLayers,
  ComputeRunner,
  DeformedVertices,
  Material,
  Mesh,
  Renderable,
  RenderSource,
  TracedScene,
  worldMatrixOf,
} from '@fdw/engine-core';
import { Frustum } from '@fdw/engine-geometry';
import {
  compile,
  CompiledProgram,
  HitResources,
  NodeRegistry,
  RayAlphaMaskVec4s,
  RayInstanceFlags,
  RayInstanceVec4s,
  RayMasks,
  RaySurfaceVec4s,
  RayVertexVec4s,
} from '@fdw/engine-shader';
import {
  alphaMaskHits,
  alphaMaskKernel,
  alphaMaskSquare,
  AlphaMaskTexels,
} from './alphaMasks';
import { deformedVerticesKernel, NoAttribute } from './deformed';
import { GrowableBuffer } from './GrowableBuffer';
import { MaterialHits, materialValues } from './MaterialHits';
import { rayMeshData, RayMeshData } from './meshData';

/** What a scene of rays holds, from a source or a list of items. */
export interface RaySceneUpdate {
  /** The items of a source (a scene graph), all of them: rays see behind. */
  readonly source?: RenderSource;
  /** Items besides those of the source. */
  readonly items?: Iterable<Renderable>;
  /** The layers traced (default all). */
  readonly layers?: number;
  /** Which items are traced (default: all those rays can hit). */
  readonly filter?: (item: Renderable) => boolean;
}

/** An instance of the traced scene: an item, and its material. */
export interface RayInstance {
  readonly item: Renderable;
  /** Its material, an index in RayScene.materials. */
  readonly material: number;
}

// What the scene keeps of a mesh: its bottom level, and where its
// triangles and the records of its vertices are in the geometry of the
// scene (vec4 offsets).
interface MeshEntry {
  readonly version: number;
  readonly bottom: GpuBottomLevel;
  readonly firstTriangle: number;
  readonly triangleCount: number;
  readonly firstVertex: number;
  readonly vertexVec4s: number;
  readonly unsubscribe: () => void;
}

// The frustum of a query of everything: planes that every point is inside.
const everywhere = (() => {
  const frustum = new Frustum();
  for (let plane = 0; plane < 6; plane++) {
    frustum.planes.set([plane === 0 ? 1 : 0, plane === 0 ? 0 : 1, 0, 1e30], plane * 4);
  }
  return frustum;
})();

// The materials whose vertices come from their vertex stage
// (output.attribute: the patches of a tessellated terrain): the rays would
// see the mesh, not what is drawn.
const generated = new WeakMap<Material['graph'], boolean>();
function generatesGeometry(material: Material): boolean {
  let value = generated.get(material.graph);
  if (value === undefined) {
    value = material.graph.nodes.some(
      (node) =>
        node.type === 'output.attribute' ||
        (node.type === 'input.builtin' &&
          (node.params['builtin'] === 'vertex-index' ||
            node.params['builtin'] === 'instance-index')),
    );
    generated.set(material.graph, value);
  }
  return value;
}

/** Floats of an instance record (rayInstances). */
const InstanceFloats = RayInstanceVec4s * 4;

// The mask of a masked material: its vec4 in the geometry, the version of
// the material it was baked from.
interface MaskEntry {
  readonly offset: number;
  version: number;
}

// What the bakes of the masks use, made at the first masked material: the
// square (its triangles and vertices in the geometry), the hits of its
// texels, the surfaces evaluated, the programs.
interface Baker {
  readonly square: number;
  readonly hits: GpuBuffer;
  readonly surfaces: GpuBuffer;
  readonly materials: MaterialHits;
  readonly pack: CompiledProgram;
  // The instance whose record is that of the square: hits made for it.
  instance: number;
}

// The flags hold the vec4 of the mask from bit 8: 24 bits.
const MaxMaskOffset = 1 << 24;

/**
 * The scene the rays are traced against: the acceleration structures of
 * the backend (a bottom level per mesh, kept while the mesh does not
 * change; the instances, updated each frame) and the buffers of the hits
 * (rayInstances, rayGeometry: see RayInstanceVec4s of @fdw/engine-shader). Given to the renderer (RenderOptions.rays) and to
 * the passes that trace rays.
 *
 * On the backends with the rayQuery capability (Vulkan, WebGPU).
 */
export class RayScene implements TracedScene {
  readonly backend: RenderBackend;
  private readonly _top: GpuTopLevel;
  private readonly _geometry: GrowableBuffer;
  private _instanceBuffer: GpuBuffer;
  private _instanceCapacity: number;
  private _instanceVersion = 0;
  private _instanceData = new Float32Array(0);
  private readonly _meshes = new Map<Mesh, MeshEntry>();
  private _materials: Material[] = [];
  private _instances: RayInstance[] = [];
  private _destroyed = false;
  // The records of the last update, to know whether the scene changed.
  private _last = new Float32Array(0);
  private _revision = 0;
  private readonly _masks = new Map<Material, MaskEntry>();
  private _baker?: Baker;
  private _runner?: ComputeRunner;
  private _copy?: CompiledProgram;
  private readonly _deformed = new Map<
    GpuBuffer,
    {
      mesh: Mesh;
      entry: MeshEntry;
      vertices: DeformedVertices;
      // The records of the vertices at rest.
      rest: GpuBuffer;
      seen: boolean;
    }
  >();
  private readonly _registry?: NodeRegistry;

  constructor(
    backend: RenderBackend,
    {
      capacity = 256,
      label = 'ray scene',
      registry,
    }: {
      capacity?: number;
      label?: string;
      /** The nodes of the materials, for the bakes of their alpha masks. */
      registry?: NodeRegistry;
    } = {},
  ) {
    if (
      !backend.capabilities?.rayQuery ||
      !backend.createBottomLevel ||
      !backend.createTopLevel
    ) {
      throw new Error('The backend traces no rays (rayQuery capability)');
    }
    this.backend = backend;
    this._registry = registry;
    this._top = backend.createTopLevel({ capacity, label });
    this._geometry = new GrowableBuffer(backend, 16, 1 << 16, `${label} geometry`);
    this._instanceCapacity = Math.max(1, capacity);
    this._instanceBuffer = this.createInstanceBuffer();
  }

  /** The acceleration structure of the scene. */
  get topLevel(): GpuTopLevel {
    return this._top;
  }

  /** The materials of the instances, in the order of their indices. */
  get materials(): readonly Material[] {
    return this._materials;
  }

  /** The instances of the last update, in the order of the hits. */
  get instances(): readonly RayInstance[] {
    return this._instances;
  }

  /**
   * Changes when an update changes the scene: its instances, their
   * places, their meshes or materials. What gathers images over frames
   * (the path tracer) starts again then.
   */
  get revision(): number {
    return this._revision;
  }

  get version(): number {
    return (
      this._top.version +
      this._geometry.version +
      this._instanceVersion
    );
  }

  resource(name: string): GpuBindGroupEntry['resource'] | undefined {
    switch (name) {
      case 'scene':
        return this._top;
      case 'rayInstances':
        return this._instanceBuffer;
      case 'rayGeometry':
        return this._geometry.buffer;
      default:
        return undefined;
    }
  }

  /**
   * Gathers the items, builds the structures of their new meshes, writes
   * the instances and builds the top level: submitted now, before the
   * frame that traces rays against it.
   */
  update({
    source,
    items = [],
    layers = AllLayers,
    filter,
  }: RaySceneUpdate = {}): this {
    if (this._destroyed) {
      throw new Error('The ray scene is destroyed');
    }
    const traced: Renderable[] = [];
    // The items whose material makes its geometry are traced with their
    // ray mesh, or their vertices moved on the GPU.
    const visit = (item: Renderable) => {
      if (
        (item.rayMesh ||
          item.material.deformedVertices ||
          !generatesGeometry(item.material)) &&
        (!filter || filter(item))
      ) {
        traced.push(item);
      }
    };
    source?.query(everywhere, layers, visit, 'shadow');
    for (const item of items) {
      visit(item);
    }

    const materials = new Map<Material, number>();
    const instances: RayInstance[] = [];
    const top: TopLevelInstance[] = [];
    const records: { item: Renderable; entry: MeshEntry; world: Float32Array }[] = [];
    const bakes: Material[] = [];
    for (const item of traced) {
      const deformed = item.rayMesh ? undefined : item.material.deformedVertices;
      const entry = deformed
        ? this.deformedEntry(item.mesh, deformed)
        : this.meshEntry(item.rayMesh ?? item.mesh);
      if (!entry) {
        continue;
      }
      let material = materials.get(item.material);
      if (material === undefined) {
        material = materials.size;
        materials.set(item.material, material);
      }
      const world = Float32Array.from(worldMatrixOf(item));
      const transparent = item.material.renderState.alphaMode === 'blend';
      const casts = !transparent && item.castShadow !== false;
      const mask = this.maskOf(item.material, bakes);
      top.push({
        bottom: entry.bottom,
        transform: world,
        mask: RayMasks.visible | (casts ? RayMasks.shadow : 0),
        ...(mask === undefined ? {} : { opaque: false }),
        // Where the vertices moved: the box the source knows.
        ...(deformed && item.bounds
          ? { bounds: [...item.bounds.min, ...item.bounds.max] }
          : {}),
      });
      instances.push({ item, material });
      records.push({ item, entry, world });
    }
    // The masks of the materials gone are freed.
    for (const [material, mask] of this._masks) {
      if (!materials.has(material)) {
        this._geometry.release(mask.offset, RayAlphaMaskVec4s);
        this._masks.delete(material);
      }
    }
    this._materials = [...materials.keys()];
    this._instances = instances;
    this.writeInstances(records, materials, bakes.length > 0);
    // The vertices moved on the GPU: a scene that moves.
    if ([...this._deformed.values()].some((deformed) => deformed.seen)) {
      this._revision++;
    }
    this._top.update(top);
    const encoder = this.backend.createCommandEncoder();
    this.refit(encoder);
    if (bakes.length > 0) {
      this.bake(encoder, bakes);
    }
    encoder.buildTopLevel?.(this._top);
    this.backend.submit([encoder.finish()]);
    return this;
  }

  // The vec4 of the mask of a material in the geometry: for the masked
  // materials (alphaMode 'mask'); added to `bakes` when it is to be baked.
  private maskOf(material: Material, bakes: Material[]): number | undefined {
    if (material.renderState.alphaMode !== 'mask') {
      return undefined;
    }
    let mask = this._masks.get(material);
    if (!mask) {
      const offset = this._geometry.allocate(RayAlphaMaskVec4s);
      if (offset + RayAlphaMaskVec4s > MaxMaskOffset) {
        // Out of the bits of the flags: an opaque material.
        this._geometry.release(offset, RayAlphaMaskVec4s);
        return undefined;
      }
      mask = { offset, version: -1 };
      this._masks.set(material, mask);
    }
    if (mask.version !== material.version && !bakes.includes(material)) {
      mask.version = material.version;
      bakes.push(material);
    }
    return mask.offset;
  }

  // Records the bakes of the masks of the materials (see alphaMasks.ts):
  // the hit program of each over the square, its alpha packed in bits.
  private bake(encoder: GpuCommandEncoder, materials: readonly Material[]): void {
    const baker = this.baker();
    const pass = encoder.beginComputePass('alpha masks');
    const hitGroups = [Math.ceil(AlphaMaskTexels / 64)] as const;
    for (const material of materials) {
      const program = baker.materials.program(material);
      const owner = this._masks.get(material) as MaskEntry;
      this.runner().record(pass, program, {
        values: {
          ...this.resources(),
          ...materialValues(material, program),
          [HitResources.hits]: baker.hits,
          [HitResources.surfaces]: baker.surfaces,
          [HitResources.count]: AlphaMaskTexels,
          [HitResources.material]: 0,
        },
        workgroups: hitGroups,
        owner,
      });
      this.runner().record(pass, baker.pack, {
        values: {
          raySurfaces: baker.surfaces,
          masks: this._geometry.buffer,
          maskOffset: owner.offset,
        },
        workgroups: [Math.ceil(RayAlphaMaskVec4s / 64)],
        owner,
      });
    }
    pass.end();
  }

  private baker(): Baker {
    if (this._baker) {
      return this._baker;
    }
    const square = this._geometry.allocate(2 + 4 * RayVertexVec4s);
    this._geometry.write(square, alphaMaskSquare(square));
    const buffer = (vec4s: number, label: string) =>
      this.backend.buffers.create({
        label: `alpha masks ${label}`,
        size: AlphaMaskTexels * vec4s * 16,
        usage: ['storage', 'copy-dst'],
      });
    this._baker = {
      square,
      hits: buffer(1, 'hits'),
      surfaces: buffer(RaySurfaceVec4s, 'surfaces'),
      materials: new MaterialHits(this.backend, this._registry),
      pack: compile(alphaMaskKernel(), {
        capabilities: this.backend.capabilities,
      }),
      instance: -1,
    };
    return this._baker;
  }

  // The resources of the scene, by their names in the programs.
  private resources(): Record<string, GpuBindGroupEntry['resource']> {
    return {
      scene: this._top,
      rayInstances: this._instanceBuffer,
      rayGeometry: this._geometry.buffer,
    };
  }

  /** Frees the structures and the buffers. */
  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    for (const [mesh, entry] of this._meshes) {
      this.forget(mesh, entry);
    }
    this._top.destroy();
    this._geometry.destroy();
    this._instanceBuffer.destroy();
    for (const buffer of [...this._deformed.keys()]) {
      this.releaseDeformed(buffer);
    }
    this._runner?.destroy();
    if (this._baker) {
      this._baker.hits.destroy();
      this._baker.surfaces.destroy();
    }
  }

  // The bottom level of a mesh and its place in the buffers: made once
  // per version of the mesh; undefined for those rays cannot hit.
  private meshEntry(mesh: Mesh): MeshEntry | undefined {
    const known = this._meshes.get(mesh);
    if (known && known.version === mesh.version) {
      return known;
    }
    if (known) {
      this.forget(mesh, known);
    }
    const entry = this.createEntry(mesh, false, () => {
      const current = this._meshes.get(mesh);
      if (current) {
        this.forget(mesh, current);
      }
    });
    if (entry) {
      this._meshes.set(mesh, entry);
    }
    return entry;
  }

  // The entry of the vertices of a mesh moved on the GPU: a dynamic bottom
  // level per buffer of vertices (the items sharing the mesh move apart),
  // refit at each update.
  private deformedEntry(
    mesh: Mesh,
    vertices: DeformedVertices,
  ): MeshEntry | undefined {
    const known = this._deformed.get(vertices.buffer);
    if (known && known.entry.version === mesh.version && known.mesh === mesh) {
      known.vertices = vertices;
      known.seen = true;
      return known.entry;
    }
    if (known) {
      this.releaseDeformed(vertices.buffer);
    }
    const entry = this.createEntry(mesh, true, () => {
      if (this._deformed.get(vertices.buffer)?.mesh === mesh) {
        this.releaseDeformed(vertices.buffer);
      }
    });
    if (entry) {
      const data = rayMeshData(mesh) as RayMeshData;
      const rest = this.backend.buffers.create({
        label: `${mesh.label ?? 'deformed'} rest records`,
        size: data.vertices.byteLength,
        usage: ['storage', 'copy-dst'],
        initialData: data.vertices,
      });
      this._deformed.set(vertices.buffer, { mesh, entry, vertices, rest, seen: true });
    }
    return entry;
  }

  // The bottom level of a mesh and its place in the buffers; undefined for
  // those rays cannot hit.
  private createEntry(
    mesh: Mesh,
    dynamic: boolean,
    destroyed: () => void,
  ): MeshEntry | undefined {
    if (mesh.destroyed) {
      return undefined;
    }
    const data = rayMeshData(mesh);
    if (!data) {
      return undefined;
    }
    const bottom = (
      this.backend as Required<Pick<RenderBackend, 'createBottomLevel'>>
    ).createBottomLevel({
      positions: data.positions,
      indices: data.indices,
      ...(mesh.label ? { label: mesh.label } : {}),
      ...(dynamic ? { dynamic } : {}),
    });
    const vertexVec4s = data.vertices.length / 4;
    const firstVertex = this._geometry.allocate(vertexVec4s);
    this._geometry.write(firstVertex, data.vertices);
    // A triangle: the offsets of the records of its vertices.
    const triangleCount = data.indices.length / 3;
    const triangles = new Uint32Array(triangleCount * 4);
    for (let t = 0; t < triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        triangles[t * 4 + k] = firstVertex + data.indices[t * 3 + k] * RayVertexVec4s;
      }
    }
    const firstTriangle = this._geometry.allocate(triangleCount);
    this._geometry.write(firstTriangle, triangles);
    return {
      version: mesh.version,
      bottom,
      firstTriangle,
      triangleCount,
      firstVertex,
      vertexVec4s,
      unsubscribe: mesh.onDestroy(destroyed),
    };
  }

  private forget(mesh: Mesh, entry: MeshEntry): void {
    this.release(entry);
    this._meshes.delete(mesh);
  }

  private releaseDeformed(buffer: GpuBuffer): void {
    const deformed = this._deformed.get(buffer);
    if (deformed) {
      this.release(deformed.entry);
      deformed.rest.destroy();
      this._deformed.delete(buffer);
    }
  }

  private release(entry: MeshEntry): void {
    entry.unsubscribe();
    entry.bottom.destroy();
    this._geometry.release(entry.firstTriangle, entry.triangleCount);
    this._geometry.release(entry.firstVertex, entry.vertexVec4s);
  }

  // Records the refits of the deformed vertices seen by the update, and
  // the copies of their vertices into their records; forgets the others.
  private refit(encoder: GpuCommandEncoder): void {
    const moved = [...this._deformed].filter(([buffer, deformed]) => {
      if (!deformed.seen) {
        this.releaseDeformed(buffer);
        return false;
      }
      deformed.seen = false;
      return true;
    });
    if (moved.length === 0) {
      return;
    }
    const runner = this.runner();
    this._copy ??= compile(deformedVerticesKernel(), {
      capabilities: this.backend.capabilities,
    });
    const pass = encoder.beginComputePass('deformed vertices');
    for (const [buffer, { entry, vertices, rest }] of moved) {
      const vertexCount = entry.vertexVec4s / RayVertexVec4s;
      runner.record(pass, this._copy, {
        values: {
          vertexCount,
          firstRecord: entry.firstVertex,
          deformedStride: vertices.stride,
          deformedNormal: vertices.normal ?? NoAttribute,
          deformedTangent: vertices.tangent ?? NoAttribute,
          deformed: buffer,
          rest,
          records: this._geometry.buffer,
        },
        workgroups: [Math.ceil(vertexCount / 64)],
        owner: entry,
      });
    }
    pass.end();
    for (const [buffer, { entry, vertices }] of moved) {
      encoder.refitBottomLevel?.(entry.bottom, {
        buffer,
        stride: vertices.stride * 16,
      });
    }
  }

  private runner(): ComputeRunner {
    this._runner ??= new ComputeRunner(this.backend);
    return this._runner;
  }

  private createInstanceBuffer(): GpuBuffer {
    return this.backend.buffers.create({
      label: 'ray instances',
      size: this._instanceCapacity * InstanceFloats * 4,
      usage: ['storage', 'copy-dst'],
    });
  }

  // The records of the instances (see RayInstanceVec4s).
  // With `square`, the record of the square of the bakes follows those of
  // the instances (see bake).
  private writeInstances(
    records: readonly { item: Renderable; entry: MeshEntry; world: Float32Array }[],
    materials: ReadonlyMap<Material, number>,
    square = false,
  ): void {
    const count = records.length;
    const written = count + (square ? 1 : 0);
    if (written > this._instanceCapacity) {
      this._instanceBuffer.destroy();
      this._instanceCapacity = Math.max(written, this._instanceCapacity * 2);
      this._instanceBuffer = this.createInstanceBuffer();
      this._instanceVersion++;
    }
    if (this._instanceData.length < written * InstanceFloats) {
      this._instanceData = new Float32Array(this._instanceCapacity * InstanceFloats);
    }
    const data = this._instanceData;
    const words = new Uint32Array(data.buffer);
    data.fill(0, 0, written * InstanceFloats);
    records.forEach(({ item, entry, world }, i) => {
      const o = i * InstanceFloats;
      // The rows of the world matrix.
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 4; column++) {
          data[o + row * 4 + column] = world[column * 4 + row];
        }
      }
      // The normal matrix: the inverse transpose of the 3 × 3 part, by
      // columns (cofactors over the determinant).
      const m = (row: number, column: number) => world[column * 4 + row];
      const cofactor = (row: number, column: number) => {
        const r = [0, 1, 2].filter((k) => k !== row);
        const c = [0, 1, 2].filter((k) => k !== column);
        const minor =
          m(r[0], c[0]) * m(r[1], c[1]) - m(r[0], c[1]) * m(r[1], c[0]);
        return (row + column) % 2 === 0 ? minor : -minor;
      };
      const determinant =
        m(0, 0) * cofactor(0, 0) +
        m(0, 1) * cofactor(0, 1) +
        m(0, 2) * cofactor(0, 2);
      const scale = determinant === 0 ? 0 : 1 / determinant;
      for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
          data[o + 12 + column * 4 + row] = cofactor(row, column) * scale;
        }
      }
      const { renderState } = item.material;
      words[o + 24] = entry.firstTriangle;
      words[o + 25] = materials.get(item.material) ?? 0;
      words[o + 26] = item.id ?? 0;
      const mask = this._masks.get(item.material);
      words[o + 27] =
        (renderState.doubleSided ? RayInstanceFlags.doubleSided : 0) |
        (renderState.alphaMode !== 'opaque' ? RayInstanceFlags.alpha : 0) |
        (mask ? RayInstanceFlags.alphaTest | (mask.offset << 8) : 0);
    });
    // The meshes are in the records (their first index), the materials too.
    const records32 = data.subarray(0, count * InstanceFloats);
    const same =
      this._last.length === records32.length &&
      this._last.every((value, i) => Object.is(value, records32[i]));
    if (!same) {
      this._last = records32.slice();
      this._revision++;
    }
    if (square) {
      // The square of the bakes: the identity, its triangles, material 0.
      const o = count * InstanceFloats;
      data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], o);
      data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], o + 12);
      const baker = this.baker();
      words[o + 24] = baker.square;
      if (baker.instance !== count) {
        baker.instance = count;
        const hits = alphaMaskHits(count);
        baker.hits.write(0, hits.buffer, 0, hits.byteLength);
      }
    }
    if (written > 0) {
      this._instanceBuffer.write(
        0,
        data.buffer,
        0,
        written * InstanceFloats * 4,
      );
    }
  }
}
