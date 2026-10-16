import type { IVec3 } from '@fdw/engine-backend';
import { Transform } from '@fdw/engine-core';
import type { BaseLight, Camera, Material, Mesh } from '@fdw/engine-core';
import type { Aabb, Volume } from '@fdw/engine-geometry';
import type { Component, ComponentValues, Schema } from '../ecs/Component';
import type { SceneNode } from './contracts';
import { NodeFlags, NodeOptions, Scene } from './Scene';

/**
 * A node: the handle of an entity of a scene, with the API of objects. Its
 * data is in the columns of the scene; changing them through the node
 * invalidates what derives from them. A node whose entity was destroyed
 * throws when used.
 */
export class Node implements SceneNode {
  private _transform?: Transform;

  /** @internal Created by Scene.node(). */
  constructor(
    readonly scene: Scene,
    readonly entity: number,
    private readonly _generation: number,
  ) {}

  /**
   * The local transform: a Transform on the block of the entity in the
   * pool of the scene. Its changes invalidate the branch.
   */
  get transform(): Transform {
    this.check();
    this._transform ??= Transform.of(this.scene.transforms, this.entity);
    return this._transform;
  }

  /** @internal Called by the scene when the entity is destroyed. */
  release(): void {
    this._transform?.detach();
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
    values?: ComponentValues<S>,
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
    }: { castShadow?: boolean; volume?: Volume } = {},
  ): this {
    return this.attach(this.scene.MeshRenderer, {
      mesh,
      material,
      noShadow: castShadow ? 0 : 1,
      volume,
    });
  }

  /**
   * Bounds of the mesh in the space of the node, replacing those of its
   * positions (undefined: back to them): for the meshes deformed on the
   * GPU. See Scene.setLocalBounds.
   */
  setBounds(box: Aabb | undefined): this {
    this.check();
    this.scene.setLocalBounds(this.entity, box);
    return this;
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
