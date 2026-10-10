import type { IQuat, IVec3 } from '@fdw/engine-backend';
import type { BaseLight, Camera, Material, Mesh } from '@fdw/engine-core';
import type { Volume } from '@fdw/engine-geometry';
import type { Component, ComponentValues, Schema } from '../ecs/Component';
import type { SceneNode } from './contracts';
import { NodeFlags, NodeOptions, Scene } from './Scene';

/** The local transform of a node: its values are copies, set partially. */
export interface NodeTransform {
  position: Partial<IVec3>;
  rotation: Partial<IQuat>;
  scale: Partial<IVec3>;
}

// The local transform of a node, read and written in the Transform columns.
class LocalTransform implements NodeTransform {
  constructor(
    private readonly _scene: Scene,
    private readonly _entity: number
  ) {}

  get position(): IVec3 {
    const p = this._scene.Transform.position;
    const o = this._entity * 3;
    return { x: p[o], y: p[o + 1], z: p[o + 2] };
  }

  set position({ x, y, z }: Partial<IVec3>) {
    const p = this._scene.Transform.position;
    const o = this._entity * 3;
    if (x !== undefined) p[o] = x;
    if (y !== undefined) p[o + 1] = y;
    if (z !== undefined) p[o + 2] = z;
    this._scene.touch(this._entity);
  }

  get rotation(): IQuat {
    const r = this._scene.Transform.rotation;
    const o = this._entity * 4;
    return { x: r[o], y: r[o + 1], z: r[o + 2], w: r[o + 3] };
  }

  set rotation({ x, y, z, w }: Partial<IQuat>) {
    const r = this._scene.Transform.rotation;
    const o = this._entity * 4;
    if (x !== undefined) r[o] = x;
    if (y !== undefined) r[o + 1] = y;
    if (z !== undefined) r[o + 2] = z;
    if (w !== undefined) r[o + 3] = w;
    this._scene.touch(this._entity);
  }

  get scale(): IVec3 {
    const s = this._scene.Transform.scale;
    const o = this._entity * 3;
    return { x: s[o], y: s[o + 1], z: s[o + 2] };
  }

  set scale({ x, y, z }: Partial<IVec3>) {
    const s = this._scene.Transform.scale;
    const o = this._entity * 3;
    if (x !== undefined) s[o] = x;
    if (y !== undefined) s[o + 1] = y;
    if (z !== undefined) s[o + 2] = z;
    this._scene.touch(this._entity);
  }
}

/**
 * A node: the handle of an entity of a scene, with the API of objects. Its
 * data is in the columns of the scene; changing them through the node
 * invalidates what derives from them. A node whose entity was destroyed
 * throws when used.
 */
export class Node implements SceneNode {
  private _transform?: NodeTransform;

  /** @internal Created by Scene.node(). */
  constructor(
    readonly scene: Scene,
    readonly entity: number,
    private readonly _generation: number
  ) {}

  /** The local transform: set partially, invalidating the branch. */
  get transform(): NodeTransform {
    this.check();
    this._transform ??= new LocalTransform(this.scene, this.entity);
    return this._transform;
  }

  /** Whether the entity of the node is still alive. */
  get alive(): boolean {
    const { world } = this.scene;
    return (
      world.isAlive(this.entity) &&
      world.generation(this.entity) === this._generation
    );
  }

  private check(): void {
    if (!this.alive) {
      throw new Error(`Node ${this.entity} was removed from its scene`);
    }
  }

  get id(): number {
    return this.entity;
  }

  get name(): string {
    this.check();
    return this.scene.NodeState.label[this.entity] as string;
  }

  set name(name: string) {
    this.check();
    this.scene.NodeState.label[this.entity] = name;
  }

  /** The world matrix, up to date: a view on the column of the scene. */
  get worldMatrix(): Float32Array {
    this.check();
    return this.scene.worldMatrix(this.entity);
  }

  /** The position in the world: the translation of the world matrix. */
  get worldPosition(): IVec3 {
    const m = this.worldMatrix;
    return { x: m[12], y: m[13], z: m[14] };
  }

  get parent(): Node | undefined {
    this.check();
    const parent = this.scene.Hierarchy.parent[this.entity];
    return parent < 0 ? undefined : this.scene.node(parent);
  }

  get children(): Node[] {
    this.check();
    const { Hierarchy } = this.scene;
    const children: Node[] = [];
    for (
      let child = Hierarchy.first[this.entity];
      child >= 0;
      child = Hierarchy.next[child]
    ) {
      children.push(this.scene.node(child));
    }
    return children;
  }

  /** Adds a new child, or moves a node under this one (keeping its local transform). */
  add(child: Node | NodeOptions = {}): Node {
    this.check();
    if (child instanceof Node) {
      this.scene.setParent(child.entity, this.entity);
      return child;
    }
    return this.scene.node(this.scene.create(this.entity, child));
  }

  /** Removes the node and its descendants from the scene. */
  remove(): void {
    this.check();
    this.scene.destroy(this.entity);
  }

  /** Gives a component to the entity of the node, or writes its values. */
  attach<S extends Schema>(
    component: Component<S>,
    values?: ComponentValues<S>
  ): this {
    this.check();
    this.scene.world.add(this.entity, component, values);
    return this;
  }

  detach(component: Component): this {
    this.check();
    this.scene.world.remove(this.entity, component);
    return this;
  }

  has(component: Component): boolean {
    this.check();
    return component.has(this.entity);
  }

  /** Draws a mesh with a material at the node. */
  setMesh(
    mesh: Mesh,
    material: Material,
    {
      castShadow = true,
      volume,
    }: { castShadow?: boolean; volume?: Volume } = {}
  ): this {
    return this.attach(this.scene.MeshRenderer, {
      mesh,
      material,
      noShadow: castShadow ? 0 : 1,
      volume,
    });
  }

  /** A light at the node, shining along its -z axis. */
  setLight(light: BaseLight): this {
    return this.attach(this.scene.Light, { light });
  }

  /** A camera at the node, looking along its -z axis. */
  setCamera(camera: Camera): this {
    return this.attach(this.scene.CameraView, { camera });
  }

  get layers(): number {
    this.check();
    return this.scene.NodeState.layers[this.entity];
  }

  set layers(layers: number) {
    this.check();
    this.scene.NodeState.layers[this.entity] = layers;
  }

  /** Hidden nodes are not drawn, nor their descendants. */
  get visible(): boolean {
    return !this.flag(NodeFlags.Hidden);
  }

  set visible(visible: boolean) {
    this.setFlag(NodeFlags.Hidden, !visible);
    this.scene.touch(this.entity);
  }

  /**
   * A static node does not move: its renderers go to the static index,
   * built at once. Set on the node and its descendants.
   */
  get static(): boolean {
    return this.flag(NodeFlags.Static);
  }

  set static(value: boolean) {
    this.traverse((node) => {
      node.setFlag(NodeFlags.Static, value);
      // Re-indexed at the next flush.
      this.scene.MeshRenderer.boundsVersion[node.entity] = 0xffffffff;
    });
    this.scene.touch(this.entity);
  }

  /** A good occluder (a wall, a building), for the occlusion culling. */
  get occluder(): boolean {
    return this.flag(NodeFlags.Occluder);
  }

  set occluder(value: boolean) {
    this.setFlag(NodeFlags.Occluder, value);
  }

  /** The last camera query (Scene.cameraQueries) that kept the node. */
  get lastVisible(): number {
    this.check();
    return this.scene.NodeState.lastVisible[this.entity];
  }

  /** Visits the node, then its descendants, depth first. */
  traverse(visit: (node: Node) => void): void {
    this.check();
    visit(this);
    for (const child of this.children) {
      child.traverse(visit);
    }
  }

  private flag(bit: number): boolean {
    this.check();
    return (this.scene.NodeState.flags[this.entity] & bit) !== 0;
  }

  private setFlag(bit: number, value: boolean): void {
    this.check();
    const { flags } = this.scene.NodeState;
    flags[this.entity] = value
      ? flags[this.entity] | bit
      : flags[this.entity] & ~bit;
  }
}
