import {
  mergeKey,
  mergeMeshes,
  type Material,
  type Mesh,
  type MeshPart,
  type Renderable,
  type WorldRenderItem,
  type WorldTransform,
} from '@fdw/engine-core';
import { Aabb, Frustum, Octree } from '@fdw/engine-geometry';
import { NodeFlags, Scene, SceneBatching } from './Scene';

/** How the static renderers of a scene are grouped into batches. */
export interface StaticBatchesOptions {
  /**
   * The side of the cells of the grid that groups the renderers, by the
   * center of their bounds, in units of the scene. A batch is culled as a
   * whole and rebuilt when one of its renderers changes: smaller cells
   * cull finer and rebuild less, larger ones draw fewer calls. Default 32.
   */
  readonly cellSize?: number;
  /**
   * The vertices of a batch at most: the renderers of a cell and of a
   * material beyond them start another batch. Default 262 144.
   */
  readonly maxVertices?: number;
  /**
   * The renderers of a cell and of a material are merged from this many;
   * fewer are drawn alone. Default 2.
   */
  readonly minCount?: number;
  /**
   * Whether a static renderer may be batched (its entity): to leave some
   * out, those of a level of detail (SceneLods), or those to select. All
   * by default.
   */
  readonly filter?: (entity: number) => boolean;
}

/** What the batches of a scene hold: see StaticBatches.stats. */
export interface StaticBatchesStats {
  // The batches, and the renderers they draw.
  readonly batches: number;
  readonly batched: number;
  readonly vertices: number;
  // The bytes of the merged vertices and indices: a second copy of the
  // geometry of the batched renderers, on the GPU and on the CPU.
  readonly bytes: number;
  // The batches rebuilt since the start, and the time spent, in ms.
  readonly rebuilds: number;
  readonly rebuildTime: number;
}

/** A batch: the renderers of a cell and of a material, merged in one mesh. */
export class StaticBatch implements WorldRenderItem {
  readonly world: WorldTransform = {
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    version: 0,
  };
  readonly bounds = Aabb.empty();

  constructor(
    readonly mesh: Mesh,
    readonly material: Material,
    readonly castShadow: boolean,
    readonly layers: number,
    // The renderers merged, in the order of their vertices.
    readonly entities: Uint32Array,
  ) {}
}

// The renderers of a cell, of a material, of the same attributes, layers
// and shadow: what can be merged.
interface Group {
  readonly key: string;
  readonly members: Set<number>;
  batches: StaticBatch[];
}

// What a candidate was grouped with: its group changes with it.
interface Member {
  group: Group;
  worldVersion: number;
  mesh: Mesh;
  meshVersion: number;
}

/**
 * The static batching of a scene: its static renderers that share a
 * material, in a cell of a grid, merged into one mesh in world space and
 * drawn in one call. For the heterogeneous static scenes, where each object
 * has its own mesh (a hand-made set, an imported level): instancing already
 * draws in one call the objects sharing a mesh and a material.
 *
 * A batch is rebuilt, at the next flush of the scene, when one of its
 * renderers changes (moves, is hidden, removed, given another mesh or
 * material: see Scene.rendererChanged). The renderers batched get the flag
 * NodeFlags.Batched: the render queries give their batch instead, the
 * other queries (raycasts, volumes) still find them, and the 'object-id'
 * outputs still write their own identifier, stored per vertex.
 *
 * What is batched: the renderers of static nodes, visible, whose mesh has
 * triangles in 32-bit float positions (mergeKey) and whose material is not
 * transparent (blended items are sorted by object). A material reading the
 * vertex attributes in the space of the object (`object.world` times the
 * position, as most do, is right) sees them in world space.
 */
export class StaticBatches implements SceneBatching {
  private readonly _cellSize: number;
  private readonly _maxVertices: number;
  private readonly _minCount: number;
  private readonly _filter?: (entity: number) => boolean;
  private readonly _groups = new Map<string, Group>();
  private readonly _members = new Map<number, Member>();
  private readonly _dirty = new Set<Group>();
  private readonly _index = new Octree<StaticBatch>();
  private readonly _materials = new WeakMap<Material, number>();
  private _nextMaterial = 0;
  private readonly _box = new Aabb();
  private _rebuilds = 0;
  private _rebuildTime = 0;

  constructor(
    private readonly _scene: Scene,
    options: StaticBatchesOptions = {},
  ) {
    if (_scene.batching) {
      throw new Error('The scene has static batches already');
    }
    this._cellSize = options.cellSize ?? 32;
    this._maxVertices = options.maxVertices ?? 262_144;
    this._minCount = Math.max(1, options.minCount ?? 2);
    this._filter = options.filter;
    _scene.batching = this;
    // The static renderers already there.
    for (const entity of _scene.world.query(_scene.MeshRenderer).entities) {
      _scene.rendererChanged(entity);
    }
  }

  /** The batches, as drawn at the last flush. */
  get batches(): StaticBatch[] {
    this._scene.flush();
    return [...this._groups.values()].flatMap((group) => group.batches);
  }

  /** The batch drawing a renderer, if any. */
  batchOf(entity: number): StaticBatch | undefined {
    this._scene.flush();
    return this._members
      .get(entity)
      ?.group.batches.find((batch) => batch.entities.includes(entity));
  }

  get stats(): StaticBatchesStats {
    let batches = 0;
    let batched = 0;
    let vertices = 0;
    let bytes = 0;
    for (const batch of this.batches) {
      batches++;
      batched += batch.entities.length;
      vertices += batch.mesh.description.vertexCount;
      bytes +=
        batch.mesh.vertices.reduce((sum, data) => sum + data.byteLength, 0) +
        (batch.mesh.indices?.byteLength ?? 0);
    }
    return {
      batches,
      batched,
      vertices,
      bytes,
      rebuilds: this._rebuilds,
      rebuildTime: this._rebuildTime,
    };
  }

  /**
   * Stops batching: the renderers are drawn alone again, the merged meshes
   * are destroyed.
   */
  destroy(): void {
    if (this._scene.batching !== this) {
      return;
    }
    for (const group of this._groups.values()) {
      this.clear(group);
    }
    this._groups.clear();
    this._members.clear();
    this._dirty.clear();
    this._scene.batching = undefined;
  }

  // --- SceneBatching ------------------------------------------------------------

  /** @internal */
  changed(entity: number): void {
    const { MeshRenderer, transforms } = this._scene;
    const key = this.keyOf(entity);
    const member = this._members.get(entity);
    if (key === undefined) {
      if (member) {
        this.leave(entity, member);
      }
      return;
    }
    const mesh = MeshRenderer.mesh[entity] as Mesh;
    const worldVersion = transforms.worldVersion(entity);
    if (
      member &&
      member.group.key === key &&
      member.worldVersion === worldVersion &&
      member.mesh === mesh &&
      member.meshVersion === mesh.version
    ) {
      return;
    }
    if (member && member.group.key !== key) {
      this.leave(entity, member);
    }
    let group = this._groups.get(key);
    if (!group) {
      group = { key, members: new Set(), batches: [] };
      this._groups.set(key, group);
    }
    group.members.add(entity);
    this._members.set(entity, {
      group,
      worldVersion,
      mesh,
      meshVersion: mesh.version,
    });
    this._dirty.add(group);
  }

  /** @internal */
  removed(entity: number): void {
    const member = this._members.get(entity);
    if (member) {
      this.leave(entity, member);
    }
  }

  /** @internal */
  apply(): void {
    if (this._dirty.size === 0) {
      return;
    }
    const start = performance.now();
    for (const group of this._dirty) {
      this.rebuild(group);
    }
    this._dirty.clear();
    this._rebuildTime += performance.now() - start;
  }

  /** @internal */
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    camera: boolean,
  ): void {
    if (this._index.size === 0) {
      return;
    }
    const { lastVisible } = this._scene.NodeState;
    const frame = this._scene.cameraQueries;
    this._index.queryFrustum(frustum, (batch) => {
      if (!(batch.layers & layers)) {
        return;
      }
      if (camera) {
        for (const entity of batch.entities) {
          lastVisible[entity] = frame;
        }
      }
      visit(batch);
    });
  }

  // --- Groups --------------------------------------------------------------------

  // The group of a renderer, or undefined if it cannot be batched.
  private keyOf(entity: number): string | undefined {
    const { MeshRenderer, NodeState } = this._scene;
    const flags = NodeState.flags[entity];
    if (
      !(flags & NodeFlags.Static) ||
      flags & NodeFlags.HiddenInTree ||
      (this._filter && !this._filter(entity))
    ) {
      return undefined;
    }
    const mesh = MeshRenderer.mesh[entity] as Mesh;
    const material = MeshRenderer.material[entity] as Material;
    const attributes = mergeKey(mesh);
    if (
      attributes === undefined ||
      mesh.destroyed ||
      material.renderState.alphaMode === 'blend'
    ) {
      return undefined;
    }
    let id = this._materials.get(material);
    if (id === undefined) {
      id = this._nextMaterial++;
      this._materials.set(material, id);
    }
    // The cell of the center of the bounds.
    const b = MeshRenderer.bounds;
    const o = entity * 6;
    const size = this._cellSize * 2;
    const cell = [0, 1, 2]
      .map((axis) => Math.floor((b[o + axis] + b[o + 3 + axis]) / size))
      .join(',');
    return `${cell}|${id}|${MeshRenderer.noShadow[entity]}|${
      NodeState.layers[entity]
    }|${attributes}`;
  }

  private leave(entity: number, member: Member): void {
    const { group } = member;
    group.members.delete(entity);
    this._members.delete(entity);
    this._dirty.add(group);
  }

  // The batches of a group, from its members.
  private rebuild(group: Group): void {
    this.clear(group);
    if (group.members.size < this._minCount) {
      if (group.members.size === 0) {
        this._groups.delete(group.key);
      }
      return;
    }
    const { MeshRenderer, NodeState } = this._scene;
    // In the order of the entities: the same batches for the same scene.
    const members = [...group.members].sort((a, b) => a - b);
    const first = members[0];
    const material = MeshRenderer.material[first] as Material;
    const castShadow = MeshRenderer.noShadow[first] === 0;
    const layers = NodeState.layers[first];
    const flags = NodeState.flags;
    let parts: MeshPart[] = [];
    let entities: number[] = [];
    let vertices = 0;
    const flushParts = () => {
      if (entities.length >= this._minCount) {
        const batch = new StaticBatch(
          mergeMeshes(parts, { label: `static batch (${parts.length})` }),
          material,
          castShadow,
          layers,
          Uint32Array.from(entities),
        );
        const b = MeshRenderer.bounds;
        const box = this._box;
        for (const entity of entities) {
          flags[entity] |= NodeFlags.Batched;
          const o = entity * 6;
          box.setFrom(
            [b[o], b[o + 1], b[o + 2]],
            [b[o + 3], b[o + 4], b[o + 5]],
          );
          batch.bounds.union(box);
        }
        group.batches.push(batch);
        this._index.insert(batch, batch.bounds);
        this._rebuilds++;
      }
      parts = [];
      entities = [];
      vertices = 0;
    };
    for (const entity of members) {
      const mesh = MeshRenderer.mesh[entity] as Mesh;
      const count = mesh.description.vertexCount;
      if (vertices > 0 && vertices + count > this._maxVertices) {
        flushParts();
      }
      parts.push({
        mesh,
        matrix: this._scene.worldMatrix(entity),
        id: this._scene.objectId(entity),
      });
      entities.push(entity);
      vertices += count;
    }
    flushParts();
  }

  // Removes the batches of a group: their renderers are drawn alone.
  private clear(group: Group): void {
    const flags = this._scene.NodeState.flags;
    for (const batch of group.batches) {
      for (const entity of batch.entities) {
        flags[entity] &= ~NodeFlags.Batched;
      }
      this._index.remove(batch);
      batch.mesh.destroy();
    }
    group.batches = [];
  }
}
