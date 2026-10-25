import type {
  GpuBindGroupEntry,
  GpuBottomLevel,
  GpuBuffer,
  GpuTopLevel,
  RenderBackend,
  TopLevelInstance,
} from '@fdw/engine-backend';
import {
  AllLayers,
  Material,
  Mesh,
  Renderable,
  RenderSource,
  TracedScene,
  worldMatrixOf,
} from '@fdw/engine-core';
import { Frustum } from '@fdw/engine-geometry';
import {
  RayInstanceFlags,
  RayInstanceVec4s,
  RayMasks,
  RayVertexVec4s,
} from '@fdw/engine-shader';
import { GrowableBuffer } from './GrowableBuffer';
import { rayMeshData } from './meshData';

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

  constructor(
    backend: RenderBackend,
    { capacity = 256, label = 'ray scene' }: { capacity?: number; label?: string } = {},
  ) {
    if (
      !backend.capabilities?.rayQuery ||
      !backend.createBottomLevel ||
      !backend.createTopLevel
    ) {
      throw new Error('The backend traces no rays (rayQuery capability)');
    }
    this.backend = backend;
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
    const visit = (item: Renderable) => {
      if (!generatesGeometry(item.material) && (!filter || filter(item))) {
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
    for (const item of traced) {
      const entry = this.meshEntry(item.mesh);
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
      top.push({
        bottom: entry.bottom,
        transform: world,
        mask: RayMasks.visible | (casts ? RayMasks.shadow : 0),
      });
      instances.push({ item, material });
      records.push({ item, entry, world });
    }
    this._materials = [...materials.keys()];
    this._instances = instances;
    this.writeInstances(records, materials);
    this._top.update(top);
    const encoder = this.backend.createCommandEncoder();
    encoder.buildTopLevel?.(this._top);
    this.backend.submit([encoder.finish()]);
    return this;
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
    const entry: MeshEntry = {
      version: mesh.version,
      bottom,
      firstTriangle,
      triangleCount,
      firstVertex,
      vertexVec4s,
      unsubscribe: mesh.onDestroy(() => {
        const current = this._meshes.get(mesh);
        if (current) {
          this.forget(mesh, current);
        }
      }),
    };
    this._meshes.set(mesh, entry);
    return entry;
  }

  private forget(mesh: Mesh, entry: MeshEntry): void {
    entry.unsubscribe();
    entry.bottom.destroy();
    this._geometry.release(entry.firstTriangle, entry.triangleCount);
    this._geometry.release(entry.firstVertex, entry.vertexVec4s);
    this._meshes.delete(mesh);
  }

  private createInstanceBuffer(): GpuBuffer {
    return this.backend.buffers.create({
      label: 'ray instances',
      size: this._instanceCapacity * InstanceFloats * 4,
      usage: ['storage', 'copy-dst'],
    });
  }

  // The records of the instances (see RayInstanceVec4s).
  private writeInstances(
    records: readonly { item: Renderable; entry: MeshEntry; world: Float32Array }[],
    materials: ReadonlyMap<Material, number>,
  ): void {
    const count = records.length;
    if (count > this._instanceCapacity) {
      this._instanceBuffer.destroy();
      this._instanceCapacity = Math.max(count, this._instanceCapacity * 2);
      this._instanceBuffer = this.createInstanceBuffer();
      this._instanceVersion++;
    }
    if (this._instanceData.length < count * InstanceFloats) {
      this._instanceData = new Float32Array(this._instanceCapacity * InstanceFloats);
    }
    const data = this._instanceData;
    const words = new Uint32Array(data.buffer);
    data.fill(0, 0, count * InstanceFloats);
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
      words[o + 27] =
        (renderState.doubleSided ? RayInstanceFlags.doubleSided : 0) |
        (renderState.alphaMode !== 'opaque' ? RayInstanceFlags.alpha : 0);
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
    if (count > 0) {
      this._instanceBuffer.write(
        0,
        data.buffer,
        0,
        count * InstanceFloats * 4,
      );
    }
  }
}
