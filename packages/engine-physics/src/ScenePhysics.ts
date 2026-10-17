import type { IQuat, IVec3 } from '@fdw/engine-backend';
import { TransformLayout } from '@fdw/engine-core';
import type { Node, Scene, Scheduler } from '@fdw/engine-scene';
import type {
  BodyDesc,
  CharacterDesc,
  ContactEvent,
  PhysicsBody,
  PhysicsCharacter,
  PhysicsCollider,
  PhysicsWorld,
} from './api';
import { PoseSize } from './api';
import { mixPoses, poseOfMatrix } from './math';

/**
 * Who moves whom:
 * - `body`: the simulation moves the body, the node follows it, drawn
 *   between two steps (the dynamic bodies, the characters);
 * - `node`: the code moves the node, the body follows it at each step (the
 *   kinematic bodies: a platform, a door animated as a node);
 * - `none`: neither moves (the static bodies).
 */
export type BodyFollow = 'body' | 'node' | 'none';

/** A body of a node: its pose comes from the node. */
export type NodeBodyDesc = Omit<BodyDesc, 'position' | 'rotation'> & {
  /** Default: `body` for dynamic bodies, `node` for kinematic ones. */
  readonly follow?: BodyFollow;
};

const Follow = { none: 0, body: 1, node: 2 } as const;

export interface InstallOptions {
  /** The name of the system of the fixed phase. Default `physics`. */
  readonly name?: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

/**
 * The bodies of a physics world as components of the entities of a scene:
 * the simulation a system of the fixed step, the nodes of the dynamic
 * bodies following them, drawn between the last two steps.
 *
 * ```ts
 * const physics = new ScenePhysics(scene, world);
 * physics.add(node, { type: 'dynamic', colliders: [{ shape: Shapes.box(0.5) }] });
 * physics.install(scheduler);
 * ```
 */
export class ScenePhysics {
  /**
   * The component of the entities with a body: the body, who follows whom,
   * the poses of the last two steps (the interpolation), whether it moved.
   */
  readonly Body;
  /** Draws the nodes between the last two steps. Default true. */
  interpolate = true;

  private readonly _query;
  private readonly _entities = new Map<PhysicsBody, number>();
  private readonly _characters = new Map<number, PhysicsCharacter>();
  private readonly _pose = new Float32Array(PoseSize);
  // The poses of the last two steps of a node, side by side.
  private readonly _mix = new Float32Array(2 * PoseSize);
  private readonly _unsubscribe: () => void;

  constructor(
    readonly scene: Scene,
    readonly world: PhysicsWorld,
  ) {
    this.Body = scene.world.defineComponent('physics body', {
      body: 'ref',
      follow: 'u8',
      moved: 'u8',
      previous: ['f32', PoseSize],
      current: ['f32', PoseSize],
    });
    this._query = scene.world.query(this.Body);
    // A node removed takes its body with it.
    this._unsubscribe = scene.world.onRemoved(this.Body, (entity) => {
      const body = this.Body.body[entity] as PhysicsBody;
      this._entities.delete(body);
      const character = this._characters.get(entity);
      if (character) {
        this._characters.delete(entity);
        this.world.removeCharacter(character);
      } else {
        this.world.removeBody(body);
      }
    });
  }

  /** The events of the last step: contacts, sensors entered and left. */
  get events(): readonly ContactEvent[] {
    return this.world.events;
  }

  /**
   * Gives a body to a node, at the pose of the node in the world (its
   * scale is the one of the meshes, not of the shapes). A node following
   * its body is under the root of the scene.
   */
  add(node: Node, desc: NodeBodyDesc): PhysicsBody {
    const follow =
      desc.follow ??
      (desc.type === 'dynamic'
        ? 'body'
        : desc.type === 'kinematic'
          ? 'node'
          : 'none');
    const [position, rotation] = this.nodePose(node, follow);
    const body = this.world.createBody({ ...desc, position, rotation });
    this.attach(node, body, follow);
    return body;
  }

  /** A character controller at the node, which follows it. */
  addCharacter(
    node: Node,
    desc: Omit<CharacterDesc, 'position'>,
  ): PhysicsCharacter {
    const [position] = this.nodePose(node, 'body');
    const character = this.world.createCharacter({ ...desc, position });
    this._characters.set(node.entity, character);
    this.attach(node, character.body, 'body');
    return character;
  }

  /** Removes the body (or the character) of a node; the node stays. */
  remove(node: Node): void {
    this.scene.world.remove(node.entity, this.Body);
  }

  bodyOf(node: Node | number): PhysicsBody | undefined {
    const entity = typeof node === 'number' ? node : node.entity;
    return this.Body.has(entity)
      ? (this.Body.body[entity] as PhysicsBody)
      : undefined;
  }

  characterOf(node: Node | number): PhysicsCharacter | undefined {
    return this._characters.get(typeof node === 'number' ? node : node.entity);
  }

  /** The entity of a body, or of the body of a collider. */
  entityOf(of: PhysicsBody | PhysicsCollider): number | undefined {
    return this._entities.get('body' in of ? of.body : of);
  }

  /** The node of a body, or of the body of a collider. */
  nodeOf(of: PhysicsBody | PhysicsCollider): Node | undefined {
    const entity = this.entityOf(of);
    return entity === undefined ? undefined : this.scene.node(entity);
  }

  /**
   * Moves a body and its node at once, without drawing the way between:
   * a respawn.
   */
  teleport(node: Node, position?: Partial<IVec3>, rotation?: IQuat): void {
    const body = this.bodyOf(node);
    if (!body) {
      throw new Error(`Node ${node.entity} has no body`);
    }
    body.setPose(position, rotation);
    if (body.type === 'dynamic') {
      body.linearVelocity = { x: 0, y: 0, z: 0 };
      body.angularVelocity = { x: 0, y: 0, z: 0 };
    }
    const { previous, current, moved } = this.Body;
    const o = node.entity * PoseSize;
    body.readPose(current, o);
    previous.set(current.subarray(o, o + PoseSize), o);
    moved[node.entity] = 1;
    this.write(node.entity, 1);
  }

  /**
   * One step: the kinematic bodies to their nodes, the simulation, the
   * poses of the bodies read.
   */
  step(dt: number): void {
    const { Body } = this;
    const { follow, previous, current, moved } = Body;
    const entities = this._query.entities;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (follow[e] === Follow.node) {
        poseOfMatrix(this.scene.worldMatrix(e), this._pose);
        const p = this._pose;
        (Body.body[e] as PhysicsBody).moveTo(
          { x: p[0], y: p[1], z: p[2] },
          { x: p[3], y: p[4], z: p[5], w: p[6] },
        );
      }
    }
    this.world.step(dt);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (follow[e] !== Follow.body) {
        continue;
      }
      const o = e * PoseSize;
      previous.set(current.subarray(o, o + PoseSize), o);
      (Body.body[e] as PhysicsBody).readPose(current, o);
      let changed = 0;
      for (let k = o; k < o + PoseSize; k++) {
        if (current[k] !== previous[k]) {
          changed = 1;
          break;
        }
      }
      // 1: moving; 2: stopped at this step, written once more; 0: at rest.
      moved[e] = changed ? 1 : moved[e] === 1 ? 2 : 0;
    }
  }

  /**
   * The nodes of the moving bodies, between the last two steps by `alpha`
   * (from 0 to 1): `scheduler.alpha`.
   */
  sync(alpha: number): void {
    const { follow, moved } = this.Body;
    const entities = this._query.entities;
    const t = this.interpolate ? alpha : 1;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (follow[e] === Follow.body && moved[e] !== 0) {
        this.write(e, t);
      }
    }
  }

  /**
   * The systems of the physics: `physics` in the fixed phase (step), and
   * `physics:sync` in the update phase (the nodes drawn between two steps).
   */
  install(scheduler: Scheduler, options: InstallOptions = {}): void {
    const name = options.name ?? 'physics';
    scheduler.add(name, (dt) => this.step(dt), {
      phase: 'fixed',
      before: options.before,
      after: options.after,
    });
    scheduler.add(`${name}:sync`, () => this.sync(scheduler.alpha), {
      phase: 'update',
    });
  }

  /** Removes the bodies of the scene from the world, and stops listening. */
  destroy(): void {
    const entities = [...this._query.entities];
    for (const entity of entities) {
      this.scene.world.remove(entity, this.Body);
    }
    this._unsubscribe();
  }

  private nodePose(node: Node, follow: BodyFollow): [Partial<IVec3>, IQuat] {
    if (
      follow === 'body' &&
      this.scene.Hierarchy.parent[node.entity] !== this.scene.root.entity
    ) {
      throw new Error(
        `Node ${node.entity} follows its body: it must be under the root of the scene`,
      );
    }
    const pose = this._pose;
    poseOfMatrix(node.worldMatrix, pose);
    return [
      { x: pose[0], y: pose[1], z: pose[2] },
      { x: pose[3], y: pose[4], z: pose[5], w: pose[6] },
    ];
  }

  private attach(node: Node, body: PhysicsBody, follow: BodyFollow): void {
    if (this.Body.has(node.entity)) {
      this.remove(node);
    }
    node.attach(this.Body, { body, follow: Follow[follow], moved: 0 });
    const o = node.entity * PoseSize;
    body.readPose(this.Body.current, o);
    this.Body.previous.set(this.Body.current.subarray(o, o + PoseSize), o);
    this._entities.set(body, node.entity);
  }

  // The local transform of a node following its body, between the last
  // two steps.
  private write(entity: number, t: number): void {
    const { stride, position, rotation } = TransformLayout;
    const { previous, current } = this.Body;
    const { data } = this.scene.transforms;
    const o = entity * PoseSize;
    const poses = this._mix;
    poses.set(previous.subarray(o, o + PoseSize), 0);
    poses.set(current.subarray(o, o + PoseSize), PoseSize);
    const block = entity * stride;
    mixPoses(poses, 0, PoseSize, t, data, block + position, block + rotation);
    this.scene.transforms.touch(entity);
  }
}
