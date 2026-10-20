import type { IQuat, IVec3 } from '@fdw/engine-backend';
import {
  AllLayers,
  BaseLight,
  Camera,
  composeBlock,
  DirectionalLight,
  Material,
  Mesh,
  meshBox,
  PointLight,
  Renderable,
  RenderItem,
  SpotLight,
  Transform,
  TransformLayout,
  TransformPool,
} from '@fdw/engine-core';
import {
  Aabb,
  Frustum,
  intersects,
  Octree,
  Ray,
  transformAabb,
  Volume,
} from '@fdw/engine-geometry';
import { World } from '../ecs/World';
import { premultiplyAt, rotationOf } from './matrices';
import type { SceneGraph } from './contracts';
import { Node } from './Node';

/** The bits of NodeState.flags. Zero is the default of every flag. */
export const NodeFlags = {
  // Hidden, with its descendants.
  Hidden: 1,
  // Does not move: indexed once, in the static index.
  Static: 2,
  // A good occluder (a wall, a building), for the occlusion culling.
  Occluder: 4,
  // The world matrix needs to be recomputed.
  Stale: 8,
  // In the list of the changes to apply before the next query.
  Queued: 16,
  // Hidden by itself or by an ancestor: computed with the world matrix.
  HiddenInTree: 32,
  // Left out by its level of detail (SceneLods): not drawn nor found, but
  // kept in its index, without invalidation. Set on the renderers.
  Culled: 64,
  // Drawn in a static batch (StaticBatches): left out of the render
  // queries, which give the batch instead, but found by the others.
  Batched: 128,
} as const;

/**
 * What changed for an entity, as told to the observers of a scene
 * (Scene.observe): created; removed (destroyed); moved (its local
 * transform, its parent or its visibility: its branch moves with it);
 * modified (a component given or taken, its mesh, its name, its layers…).
 */
export type SceneChange = 'created' | 'removed' | 'moved' | 'modified';

/** Told of each change of the entities of a scene: see Scene.observe. */
export type SceneObserver = (entity: number, change: SceneChange) => void;

/** What a node is created with. */
export interface NodeOptions {
  readonly name?: string;
  readonly position?: Partial<IVec3>;
  readonly rotation?: Partial<IQuat>;
  readonly scale?: Partial<IVec3>;
  // The layers of the node: the views whose layers intersect them see it.
  // Default: all.
  readonly layers?: number;
  readonly visible?: boolean;
  readonly static?: boolean;
  readonly occluder?: boolean;
}

/**
 * Many entities created at once (Scene.createBatch): the same options for
 * all of them, their transforms in flat arrays, and optionally a mesh and a
 * material drawn by each.
 */
export interface BatchOptions {
  readonly count: number;
  // The parent of every entity: the root by default.
  readonly parent?: number;
  // x, y, z per entity (3 × count); the origin by default.
  readonly positions?: ArrayLike<number>;
  // x, y, z, w per entity (4 × count); none by default.
  readonly rotations?: ArrayLike<number>;
  // x, y, z per entity (3 × count); 1 by default.
  readonly scales?: ArrayLike<number>;
  // Drawn by every entity (setMesh).
  readonly mesh?: Mesh;
  readonly material?: Material;
  readonly castShadow?: boolean;
  readonly name?: string;
  readonly layers?: number;
  readonly visible?: boolean;
  readonly static?: boolean;
  readonly occluder?: boolean;
}

/** Options of the queries of the application. */
export interface QueryOptions {
  // The layers to search: the nodes whose layers intersect them. Default: all.
  readonly layers?: number;
  // Include the hidden nodes. Default false.
  readonly hidden?: boolean;
}

/**
 * A stage of the visibility of the camera queries, after the frustum: the
 * occlusion culling (see design/scenegraph.md §10).
 */
export interface OcclusionCuller {
  // Whether a node retained by the frustum may be visible.
  visible(scene: Scene, entity: number): boolean;
}

/**
 * @internal What a scene tells its static batches (StaticBatches), which
 * draw some of its static renderers.
 */
export interface SceneBatching {
  // The renderer may have changed: its transform, mesh, material, flags.
  changed(entity: number): void;
  // The renderer is about to go.
  removed(entity: number): void;
  // At the end of a flush: rebuilds the batches whose renderers changed.
  apply(): void;
  // The batches of the render queries.
  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    camera: boolean,
  ): void;
}

const None = -1;

const {
  stride,
  world: World0,
  position: P,
  rotation: R,
  scale: S,
} = TransformLayout;

/**
 * A scene: entities of a World, in a hierarchy, with a transform in a
 * TransformPool (local values, world and normal matrices), drawn by a
 * Renderer as a RenderSource. Its entities are handled by systems through
 * the pool and the columns of its components, or as nodes (`scene.root`,
 * `node.add()`).
 *
 * World matrices, bounds and the spatial indices are kept up to date by
 * invalidation: changing the transform of an entity marks its branch as
 * stale; a world matrix is recomputed when read, and every query (the
 * rendering, a raycast) first applies the pending changes.
 */
export class Scene implements SceneGraph {
  readonly world: World;
  /**
   * The transforms of the entities, by entity: the block of entity e at
   * `e * TransformLayout.stride` of `transforms.data`. A system writing
   * local values there calls `transforms.touch(e)` (or `scene.touch(e)`).
   */
  readonly transforms: TransformPool;
  /** Parent, first child, next and previous siblings: entities, or -1. */
  readonly Hierarchy;
  /** NodeFlags, layers, the last camera query that kept it, a name (label). */
  readonly NodeState;
  /**
   * A mesh drawn with a material; its world bounds (derived), the bounds
   * table of the GPU culling to come. `noShadow`: 1 to cast no shadow. An
   * optional Volume, for the queries. `localBounds`: an Aabb replacing the
   * bounds of the mesh, in the space of the entity (setLocalBounds).
   */
  readonly MeshRenderer;
  /** A light following the entity: position, and direction along its -z. */
  readonly Light;
  /** A camera following the entity: position and rotation. */
  readonly CameraView;

  readonly root: Node;

  /** Called before a camera query keeps a node: the occlusion culling. */
  occlusion?: OcclusionCuller;
  /** @internal The static batches, set by StaticBatches. */
  batching?: SceneBatching;

  private readonly _dynamic = new Octree<number>();
  private readonly _static = new Octree<number>();
  // The roots of the branches changed since the last flush.
  private _changes: number[] = [];
  // Static renderers not indexed yet: indexed at once, at the next flush.
  private _pendingStatic: number[] = [];
  private readonly _nodes: (Node | undefined)[] = [];
  private _cameraQueries = 0;
  private _warnedStatic = false;
  private readonly _box = new Aabb();
  private readonly _meshRenderers;
  private readonly _lights;
  private readonly _observers: SceneObserver[] = [];

  constructor() {
    const world = new World();
    this.world = world;
    this.transforms = new TransformPool({
      capacity: world.capacity,
      onTouch: (entity) => this.touch(entity),
      compute: (entity) => this.updateWorld(entity),
    });
    this.Hierarchy = world.defineComponent('hierarchy', {
      parent: 'i32',
      first: 'i32',
      next: 'i32',
      previous: 'i32',
    });
    this.NodeState = world.defineComponent('node state', {
      flags: 'u16',
      layers: 'u32',
      lastVisible: 'u32',
      label: 'ref',
    });
    this.MeshRenderer = world.defineComponent('mesh renderer', {
      mesh: 'ref',
      material: 'ref',
      noShadow: 'u8',
      volume: 'ref',
      localBounds: 'ref',
      bounds: ['f32', 6],
      // The versions of the world matrix and of the mesh of the bounds.
      boundsVersion: 'u32',
      meshVersion: 'u32',
      // The render item, and where the entity is indexed: 0 nowhere, 1 in
      // the dynamic index, 2 in the static one.
      item: 'ref',
      indexed: 'u8',
    });
    this.Light = world.defineComponent('light', { light: 'ref' });
    this.CameraView = world.defineComponent('camera view', { camera: 'ref' });
    this._meshRenderers = world.query(this.MeshRenderer);
    this._lights = world.query(this.Light);

    world.onAdded(this.MeshRenderer, (entity) => {
      this.MeshRenderer.item[entity] = this.createItem(entity);
      this.MeshRenderer.boundsVersion[entity] = 0xffffffff;
      this.queue(entity);
    });
    world.onRemoved(this.MeshRenderer, (entity) => {
      this.batching?.removed(entity);
      this.unindex(entity);
      (this.MeshRenderer.item[entity] as SceneItem).detach();
    });
    world.onAdded(this.Light, (entity) => this.queue(entity));
    world.onAdded(this.CameraView, (entity) => this.queue(entity));

    this.root = this.node(this.create(None, { name: 'root' }));
  }

  // --- Entities ------------------------------------------------------------------

  /**
   * Creates `count` entities at once, as many create() then setMesh(), but
   * without a node nor an object per entity: the transforms are read from
   * flat arrays, the components written directly. For the large static
   * sets (a level, a city, a CAD assembly). Returns the entities, in the
   * order of the arrays.
   */
  createBatch(options: BatchOptions): Uint32Array {
    const { world, NodeState, Hierarchy, MeshRenderer } = this;
    const {
      count,
      parent = this.root.entity,
      positions,
      rotations,
      scales,
      mesh,
      material,
    } = options;
    if (mesh && !material) {
      throw new Error('A batch with a mesh needs a material');
    }
    // The values of the components, the same for every entity.
    const hierarchy = { parent: None, first: None, next: None, previous: None };
    const state = {
      flags:
        (options.visible === false ? NodeFlags.Hidden : 0) |
        (options.static ? NodeFlags.Static : 0) |
        (options.occluder ? NodeFlags.Occluder : 0),
      layers: options.layers ?? AllLayers,
      label: options.name ?? '',
    };
    const renderer = mesh
      ? { mesh, material, noShadow: options.castShadow === false ? 1 : 0 }
      : undefined;
    world.reserve(count);
    const entities = new Uint32Array(count);
    let last = 0;
    for (let i = 0; i < count; i++) {
      entities[i] = world.create();
      last = Math.max(last, entities[i]);
    }
    this.transforms.reserve(last + 1);
    for (let i = 0; i < count; i++) {
      const entity = entities[i];
      this.transforms.allocateAt(entity);
      const data = this.transforms.data;
      const o = entity * stride;
      data[o + P] = positions ? positions[i * 3] : 0;
      data[o + P + 1] = positions ? positions[i * 3 + 1] : 0;
      data[o + P + 2] = positions ? positions[i * 3 + 2] : 0;
      data[o + R] = rotations ? rotations[i * 4] : 0;
      data[o + R + 1] = rotations ? rotations[i * 4 + 1] : 0;
      data[o + R + 2] = rotations ? rotations[i * 4 + 2] : 0;
      data[o + R + 3] = rotations ? rotations[i * 4 + 3] : 1;
      data[o + S] = scales ? scales[i * 3] : 1;
      data[o + S + 1] = scales ? scales[i * 3 + 1] : 1;
      data[o + S + 2] = scales ? scales[i * 3 + 2] : 1;
    }
    world.addMany(entities, Hierarchy, hierarchy);
    world.addMany(entities, NodeState, state);
    for (let i = 0; i < count; i++) {
      this.link(entities[i], parent);
      this.invalidate(entities[i]);
    }
    if (renderer) {
      world.addMany(entities, MeshRenderer, renderer);
    }
    if (this._observers.length > 0) {
      for (const entity of entities) {
        this.notify(entity, 'created');
      }
    }
    return entities;
  }

  /**
   * Creates an entity of the scene, child of `parent` (the root by
   * default): the entity level of `node.add()`.
   */
  create(parent: number = this.root.entity, options: NodeOptions = {}): number {
    const { world, NodeState } = this;
    const entity = world.create();
    this.transforms.allocateAt(entity);
    const { position, rotation, scale } = options;
    const data = this.transforms.data;
    const o = entity * stride;
    data[o + P] = position?.x ?? 0;
    data[o + P + 1] = position?.y ?? 0;
    data[o + P + 2] = position?.z ?? 0;
    data[o + R] = rotation?.x ?? 0;
    data[o + R + 1] = rotation?.y ?? 0;
    data[o + R + 2] = rotation?.z ?? 0;
    data[o + R + 3] = rotation?.w ?? 1;
    data[o + S] = scale?.x ?? 1;
    data[o + S + 1] = scale?.y ?? 1;
    data[o + S + 2] = scale?.z ?? 1;
    world.add(entity, this.Hierarchy, {
      parent: None,
      first: None,
      next: None,
      previous: None,
    });
    world.add(entity, NodeState, {
      flags:
        (options.visible === false ? NodeFlags.Hidden : 0) |
        (options.static ? NodeFlags.Static : 0) |
        (options.occluder ? NodeFlags.Occluder : 0),
      layers: options.layers ?? AllLayers,
      label: options.name ?? '',
    });
    if (parent !== None) {
      this.link(entity, parent);
    }
    this.invalidate(entity);
    this.notify(entity, 'created');
    return entity;
  }

  /** Destroys an entity and its descendants. */
  destroy(entity: number): void {
    this.flush();
    const { Hierarchy } = this;
    for (let child = Hierarchy.first[entity]; child !== None;) {
      const next = Hierarchy.next[child];
      this.destroy(child);
      child = next;
    }
    this.notify(entity, 'removed');
    this.unlink(entity);
    this._nodes[entity]?.release();
    this._nodes[entity] = undefined;
    this.world.destroy(entity);
  }

  /** Moves an entity under another parent, keeping its local transform. */
  setParent(entity: number, parent: number): void {
    for (let p = parent; p !== None; p = this.Hierarchy.parent[p]) {
      if (p === entity) {
        throw new Error('An entity cannot be moved under itself');
      }
    }
    this.unlink(entity);
    this.link(entity, parent);
    this.touch(entity);
  }

  /** The node of an entity: its handle, the same object for each call. */
  node(entity: number): Node {
    let node = this._nodes[entity];
    if (!node) {
      if (!this.world.isAlive(entity)) {
        throw new Error(`Entity ${entity} is not alive`);
      }
      node = new Node(this, entity, this.world.generation(entity));
      this._nodes[entity] = node;
    }
    return node;
  }

  // --- Observers ---------------------------------------------------------------

  /**
   * Calls `observer` for each change of an entity, as it happens: created,
   * removed, moved, modified (see SceneChange). The nodes and the scene
   * tell their changes; systems writing the columns of the components
   * directly call notify(), and touch() for the transforms. Returns a
   * function that stops observing. Without observers, nothing is called.
   */
  observe(observer: SceneObserver): () => void {
    this._observers.push(observer);
    return () => {
      const index = this._observers.indexOf(observer);
      if (index >= 0) {
        this._observers.splice(index, 1);
      }
    };
  }

  /** Tells the observers that an entity changed. */
  notify(entity: number, change: SceneChange): void {
    for (const observer of this._observers) {
      observer(entity, change);
    }
  }

  // --- Invalidation ------------------------------------------------------------

  /**
   * Signals that the transform, the parent or the visibility of an entity
   * changed: the world matrices of its branch are stale, and the indices
   * will be updated before the next query. Systems writing the local values
   * of the pool directly call it once per entity they moved. Observers are
   * told the entity moved.
   */
  touch(entity: number): void {
    this.invalidate(entity);
    if (this._observers.length > 0) {
      this.notify(entity, 'moved');
    }
  }

  // touch(), without telling the observers.
  private invalidate(entity: number): void {
    const flags = this.NodeState.flags;
    const parent = this.Hierarchy.parent[entity];
    // Already stale with its parent: its branch is queued already.
    if (
      flags[entity] & NodeFlags.Stale &&
      parent !== None &&
      flags[parent] & NodeFlags.Stale
    ) {
      return;
    }
    this.markStale(entity);
    this.queue(entity);
  }

  // Marks a branch stale, down to the entities already stale: their own
  // branches are.
  private markStale(entity: number): void {
    const { flags } = this.NodeState;
    flags[entity] |= NodeFlags.Stale;
    this.transforms.invalidate(entity);
    for (
      let child = this.Hierarchy.first[entity];
      child !== None;
      child = this.Hierarchy.next[child]
    ) {
      if (!(flags[child] & NodeFlags.Stale)) {
        this.markStale(child);
      }
    }
  }

  private queue(entity: number): void {
    const { flags } = this.NodeState;
    if (!(flags[entity] & NodeFlags.Queued)) {
      flags[entity] |= NodeFlags.Queued;
      this._changes.push(entity);
    }
  }

  /**
   * Replaces the bounds of the mesh of a renderer by `box`, in the space of
   * the entity, or goes back to those of the mesh (undefined): for the
   * meshes whose vertices move on the GPU (a skinned character), which
   * the positions of the mesh do not bound. The world bounds and the index
   * follow at the next flush. The box is read then, not copied: changing
   * it calls setLocalBounds again.
   */
  setLocalBounds(entity: number, box: Aabb | undefined): void {
    this.MeshRenderer.localBounds[entity] = box;
    this.MeshRenderer.boundsVersion[entity] = 0xffffffff;
    this.queue(entity);
  }

  /**
   * Signals that the mesh, the material, the shadow or the layers of a
   * renderer changed (Node.setMesh and Node.layers call it; systems
   * writing the columns of MeshRenderer or NodeState directly too): its
   * bounds and its static batch follow at the next flush.
   */
  rendererChanged(entity: number): void {
    if (this.MeshRenderer.has(entity)) {
      this.MeshRenderer.boundsVersion[entity] = 0xffffffff;
      this.queue(entity);
    }
  }

  /**
   * Computes the world matrix of an entity if it is stale (and those of its
   * stale ancestors first), in its block of the pool. The normal matrix is
   * computed when read (TransformPool.updateNormal()).
   */
  updateWorld(entity: number): void {
    const { flags } = this.NodeState;
    if (!(flags[entity] & NodeFlags.Stale)) {
      return;
    }
    const parent = this.Hierarchy.parent[entity];
    if (parent !== None) {
      this.updateWorld(parent);
    }
    const data = this.transforms.data;
    const o = entity * stride;
    composeBlock(data, o);
    let hidden = flags[entity] & NodeFlags.Hidden;
    if (parent !== None) {
      premultiplyAt(data, parent * stride + World0, data, o + World0);
      hidden |= flags[parent] & NodeFlags.HiddenInTree;
    }
    flags[entity] =
      (flags[entity] & ~(NodeFlags.Stale | NodeFlags.HiddenInTree)) |
      (hidden ? NodeFlags.HiddenInTree : 0);
    this.transforms.markUpdated(entity);
  }

  /**
   * Applies the pending changes: world matrices, bounds and index entries
   * of the changed branches, lights and cameras following them. Called by
   * every query; call it to apply them at a chosen time.
   */
  flush(): void {
    if (this._changes.length > 0) {
      const changes = this._changes;
      this._changes = [];
      for (const entity of changes) {
        if (this.world.isAlive(entity)) {
          this.NodeState.flags[entity] &= ~NodeFlags.Queued;
          this.applyBranch(entity);
        }
      }
    }
    if (this._pendingStatic.length > 0) {
      const pending = this._pendingStatic;
      this._pendingStatic = [];
      this._static.insertAll(this.staticEntries(pending));
    }
    this.batching?.apply();
  }

  // The static renderers waiting for the index, with their bounds: one box,
  // reused (the index copies them).
  private *staticEntries(pending: number[]): Iterable<readonly [number, Aabb]> {
    const box = new Aabb();
    const entry: [number, Aabb] = [0, box];
    for (const entity of pending) {
      if (
        this.MeshRenderer.indexed[entity] === 2 &&
        !this._static.has(entity)
      ) {
        entry[0] = entity;
        this.readBounds(entity, box);
        yield entry;
      }
    }
  }

  private applyBranch(entity: number): void {
    this.updateWorld(entity);
    const { MeshRenderer, Light, CameraView } = this;
    if (MeshRenderer.has(entity)) {
      this.updateBounds(entity);
      this.batching?.changed(entity);
    }
    if (Light.has(entity)) {
      this.follow(entity, Light.light[entity] as BaseLight);
    }
    if (CameraView.has(entity)) {
      this.follow(entity, CameraView.camera[entity] as Camera);
    }
    for (
      let child = this.Hierarchy.first[entity];
      child !== None;
      child = this.Hierarchy.next[child]
    ) {
      this.applyBranch(child);
    }
  }

  // The world bounds of a renderer, and its place in the indices.
  private updateBounds(entity: number): void {
    const { MeshRenderer } = this;
    const mesh = MeshRenderer.mesh[entity] as Mesh;
    const version = this.transforms.worldVersion(entity);
    if (
      MeshRenderer.boundsVersion[entity] === version &&
      MeshRenderer.meshVersion[entity] === mesh.version &&
      MeshRenderer.indexed[entity] !== 0
    ) {
      return;
    }
    MeshRenderer.boundsVersion[entity] = version;
    MeshRenderer.meshVersion[entity] = mesh.version;
    const box = this._box;
    const local =
      (MeshRenderer.localBounds[entity] as Aabb | undefined) ?? meshBox(mesh);
    if (local) {
      transformAabb(local, this.worldMatrixView(entity), box);
    } else {
      // No positions: a point at the origin of the entity.
      const m = this.transforms.data;
      const o = entity * stride + World0;
      box.setFrom(
        [m[o + 12], m[o + 13], m[o + 14]],
        [m[o + 12], m[o + 13], m[o + 14]],
      );
    }
    const b = MeshRenderer.bounds;
    const o = entity * 6;
    const isStatic = this.NodeState.flags[entity] & NodeFlags.Static;
    const indexed = MeshRenderer.indexed[entity];
    // The same bounds, in the right index (a renderer given another mesh
    // or other layers): nothing to move.
    if (
      indexed === (isStatic ? 2 : 1) &&
      b[o] === Math.fround(box.min[0]) &&
      b[o + 1] === Math.fround(box.min[1]) &&
      b[o + 2] === Math.fround(box.min[2]) &&
      b[o + 3] === Math.fround(box.max[0]) &&
      b[o + 4] === Math.fround(box.max[1]) &&
      b[o + 5] === Math.fround(box.max[2])
    ) {
      return;
    }
    b[o] = box.min[0];
    b[o + 1] = box.min[1];
    b[o + 2] = box.min[2];
    b[o + 3] = box.max[0];
    b[o + 4] = box.max[1];
    b[o + 5] = box.max[2];
    (MeshRenderer.item[entity] as SceneItem).boundsChanged(box);

    if (isStatic) {
      if (indexed === 2) {
        // Indexed at the end of the flush, if not yet.
        if (this._static.has(entity)) {
          this.warnStaticMove();
          this._static.update(entity, box);
        }
      } else {
        if (indexed === 1) {
          this._dynamic.remove(entity);
        }
        MeshRenderer.indexed[entity] = 2;
        this._pendingStatic.push(entity);
      }
    } else if (indexed === 1) {
      this._dynamic.update(entity, box);
    } else {
      if (indexed === 2) {
        this._static.remove(entity);
      }
      this._dynamic.insert(entity, box);
      MeshRenderer.indexed[entity] = 1;
    }
  }

  private warnStaticMove(): void {
    if (!this._warnedStatic) {
      this._warnedStatic = true;
      console.warn(
        'A static node moved: its index is updated, at a cost. Static nodes are meant not to move.',
      );
    }
  }

  private unindex(entity: number): void {
    const indexed = this.MeshRenderer.indexed[entity];
    if (indexed === 1) {
      this._dynamic.remove(entity);
    } else if (indexed === 2) {
      // Removed from the static index, or from those waiting for it.
      if (!this._static.remove(entity)) {
        this._pendingStatic = this._pendingStatic.filter((e) => e !== entity);
      }
    }
    this.MeshRenderer.indexed[entity] = 0;
  }

  // A light or a camera at the position of the entity, looking along its -z.
  private follow(entity: number, object: BaseLight | Camera): void {
    const m = this.transforms.data;
    const o = entity * stride + World0;
    const position = { x: m[o + 12], y: m[o + 13], z: m[o + 14] };
    if (object instanceof Camera) {
      object.position = position;
      object.rotation = rotationOf(m, o);
      return;
    }
    if (object instanceof PointLight || object instanceof SpotLight) {
      object.position = position;
    }
    if (object instanceof DirectionalLight || object instanceof SpotLight) {
      object.direction = { x: -m[o + 8], y: -m[o + 9], z: -m[o + 10] };
    }
  }

  // --- Reading -----------------------------------------------------------------

  /**
   * The world matrix of an entity, up to date: a view on its block of the
   * pool (replaced if the pool grows).
   */
  worldMatrix(entity: number): Float32Array {
    this.updateWorld(entity);
    return this.worldMatrixView(entity);
  }

  private worldMatrixView(entity: number): Float32Array {
    const o = entity * stride + World0;
    return this.transforms.data.subarray(o, o + 16);
  }

  /** The world bounds of a renderer, written into `out`, after the pending changes. */
  bounds(out: Aabb): Aabb;
  bounds(out: Aabb, entity: number): Aabb;
  bounds(out: Aabb, entity?: number): Aabb {
    this.flush();
    if (entity === undefined) {
      // The bounds of everything: a RenderSource for the shadows.
      out.makeEmpty();
      const box = new Aabb();
      if (this._dynamic.size > 0) {
        out.union(this._dynamic.bounds(box));
      }
      if (this._static.size > 0) {
        out.union(this._static.bounds(box));
      }
      return out;
    }
    return this.readBounds(entity, out);
  }

  private readBounds(entity: number, out: Aabb): Aabb {
    const b = this.MeshRenderer.bounds;
    const o = entity * 6;
    // Written in place: called per entity when indexing.
    const { min, max } = out;
    min[0] = b[o];
    min[1] = b[o + 1];
    min[2] = b[o + 2];
    max[0] = b[o + 3];
    max[1] = b[o + 4];
    max[2] = b[o + 5];
    return out;
  }

  /**
   * The identifier of the object of a renderer, written by the 'object-id'
   * outputs of the scene passes for its pixels, in a static batch too: its
   * entity + 1 (0 is no object).
   */
  objectId(entity: number): number {
    return entity + 1;
  }

  /** The entity of an identifier read back (pickIds), if alive. */
  entityOf(objectId: number): number | undefined {
    const entity = objectId - 1;
    return objectId > 0 && this.world.isAlive(entity) ? entity : undefined;
  }

  /** The nodes marked as occluders, for the occlusion culling. */
  occluders(): number[] {
    this.flush();
    return [...this._meshRenderers.entities].filter(
      (entity) => this.NodeState.flags[entity] & NodeFlags.Occluder,
    );
  }

  /** The number of camera queries so far: the frame of NodeState.lastVisible. */
  get cameraQueries(): number {
    return this._cameraQueries;
  }

  // --- RenderSource --------------------------------------------------------------

  query(
    frustum: Frustum,
    layers: number,
    visit: (item: Renderable) => void,
    view: 'camera' | 'shadow',
  ): void {
    this.flush();
    const camera = view === 'camera';
    if (camera) {
      this._cameraQueries++;
    }
    const { flags, layers: layerColumn, lastVisible } = this.NodeState;
    const items = this.MeshRenderer.item;
    const occlusion = camera ? this.occlusion : undefined;
    const emit = (entity: number) => {
      if (
        flags[entity] &
          (NodeFlags.HiddenInTree | NodeFlags.Culled | NodeFlags.Batched) ||
        !(layerColumn[entity] & layers) ||
        (occlusion && !occlusion.visible(this, entity))
      ) {
        return;
      }
      if (camera) {
        lastVisible[entity] = this._cameraQueries;
      }
      visit(items[entity] as SceneItem);
    };
    this._static.queryFrustum(frustum, emit);
    this._dynamic.queryFrustum(frustum, emit);
    this.batching?.query(frustum, layers, visit, camera);
  }

  lights(): BaseLight[] {
    this.flush();
    const lights: BaseLight[] = [];
    for (const entity of this._lights.entities) {
      if (!(this.NodeState.flags[entity] & NodeFlags.HiddenInTree)) {
        lights.push(this.Light.light[entity] as BaseLight);
      }
    }
    return lights;
  }

  // --- Queries of the application ---------------------------------------------

  /**
   * The renderers whose bounds the ray crosses (then their volume, if they
   * have one), nearest first. `visit` returns false to stop.
   */
  raycastEntities(
    ray: Ray,
    visit: (entity: number, distance: number) => boolean | void,
    options: QueryOptions = {},
    maxDistance = Infinity,
  ): void {
    this.flush();
    const hits: { entity: number; distance: number }[] = [];
    const collect = (entity: number, distance: number) => {
      if (this.selected(entity, options)) {
        const volume = this.MeshRenderer.volume[entity] as Volume | undefined;
        const exact = volume ? volume.raycast(ray) : distance;
        if (exact !== undefined && exact <= maxDistance) {
          hits.push({ entity, distance: exact });
        }
      }
    };
    this._static.raycast(ray, collect, maxDistance);
    this._dynamic.raycast(ray, collect, maxDistance);
    hits.sort((a, b) => a.distance - b.distance);
    for (const { entity, distance } of hits) {
      if (visit(entity, distance) === false) {
        return;
      }
    }
  }

  /**
   * The renderers whose bounds (then their volume, if they have one)
   * intersect a volume. `visit` returns false to stop.
   */
  queryVolumeEntities(
    volume: Volume,
    visit: (entity: number) => boolean | void,
    options: QueryOptions = {},
  ): void {
    this.flush();
    let stopped = false;
    const check = (entity: number) => {
      if (!this.selected(entity, options)) {
        return true;
      }
      const own = this.MeshRenderer.volume[entity] as Volume | undefined;
      if (own && !intersects(own, volume)) {
        return true;
      }
      if (visit(entity) === false) {
        stopped = true;
        return false;
      }
      return true;
    };
    this._static.queryVolume(volume, check);
    if (!stopped) {
      this._dynamic.queryVolume(volume, check);
    }
  }

  /** raycastEntities(), with nodes. */
  raycast(
    ray: Ray,
    visit: (node: Node, distance: number) => boolean | void,
    options: QueryOptions = {},
    maxDistance = Infinity,
  ): void {
    this.raycastEntities(
      ray,
      (entity, distance) => visit(this.node(entity), distance),
      options,
      maxDistance,
    );
  }

  /** queryVolumeEntities(), with nodes. */
  queryVolume(
    volume: Volume,
    visit: (node: Node) => boolean | void,
    options: QueryOptions = {},
  ): void {
    this.queryVolumeEntities(
      volume,
      (entity) => visit(this.node(entity)),
      options,
    );
  }

  /** The first node of a name, in depth-first order. */
  find(name: string): Node | undefined {
    let found: Node | undefined;
    this.root.traverse((node) => {
      if (!found && node.name === name) {
        found = node;
      }
    });
    return found;
  }

  private selected(
    entity: number,
    { layers = AllLayers, hidden = false }: QueryOptions,
  ): boolean {
    return (
      (hidden ||
        !(
          this.NodeState.flags[entity] &
          (NodeFlags.HiddenInTree | NodeFlags.Culled)
        )) &&
      (this.NodeState.layers[entity] & layers) !== 0
    );
  }

  // --- Hierarchy -------------------------------------------------------------------

  private link(entity: number, parent: number): void {
    const { Hierarchy } = this;
    const first = Hierarchy.first[parent];
    Hierarchy.parent[entity] = parent;
    Hierarchy.previous[entity] = None;
    Hierarchy.next[entity] = first;
    if (first !== None) {
      Hierarchy.previous[first] = entity;
    }
    Hierarchy.first[parent] = entity;
  }

  private unlink(entity: number): void {
    const { Hierarchy } = this;
    const parent = Hierarchy.parent[entity];
    if (parent === None) {
      return;
    }
    const previous = Hierarchy.previous[entity];
    const next = Hierarchy.next[entity];
    if (previous !== None) {
      Hierarchy.next[previous] = next;
    } else {
      Hierarchy.first[parent] = next;
    }
    if (next !== None) {
      Hierarchy.previous[next] = previous;
    }
    Hierarchy.parent[entity] = None;
    Hierarchy.next[entity] = None;
    Hierarchy.previous[entity] = None;
  }

  // --- Render items ------------------------------------------------------------------

  private createItem(entity: number): SceneItem {
    return new SceneItem(this, entity);
  }
}

/**
 * The render item of a renderer entity, created once: its transform is the
 * one of the entity, in the pool of the scene; its bounds are those computed
 * by the scene.
 */
export class SceneItem implements RenderItem {
  // Created on first read: a renderer reads those of the items it draws,
  // a small part of a large scene.
  private _bounds?: Aabb;
  private _transform?: Transform;

  constructor(
    private readonly _scene: Scene,
    readonly entity: number,
  ) {}

  get transform(): Transform {
    return (this._transform ??= Transform.of(
      this._scene.transforms,
      this.entity,
    ));
  }

  /** The world bounds, those of the bounds column of the scene. */
  get bounds(): Aabb {
    if (!this._bounds) {
      this._bounds = new Aabb();
      this._scene.bounds(this._bounds, this.entity);
    }
    return this._bounds;
  }

  /** @internal The scene computed new world bounds. */
  boundsChanged(box: Aabb): void {
    this._bounds?.copyFrom(box);
  }

  /** @internal The entity no longer draws: its transform is detached. */
  detach(): void {
    this._transform?.detach();
  }

  get mesh(): Mesh {
    return this._scene.MeshRenderer.mesh[this.entity] as Mesh;
  }

  get material(): Material {
    return this._scene.MeshRenderer.material[this.entity] as Material;
  }

  get castShadow(): boolean {
    return this._scene.MeshRenderer.noShadow[this.entity] === 0;
  }

  /** The identifier of the object, for picking: Scene.objectId(). */
  get id(): number {
    return this.entity + 1;
  }
}
