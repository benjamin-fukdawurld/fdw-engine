import type { IQuat, IVec3 } from '@fdw/engine-backend';
import type { Shape } from './shapes';

// The abstract physics API: what the engine, its systems and its tools ask
// of a physics engine. An implementation (`@fdw/engine-physics-rapier`, or
// one of the user's) translates it to its engine; nothing here depends on
// one. The units are meters, kilograms and seconds; y is up.

/**
 * - `static`: never moves (the ground, the walls); the cheapest.
 * - `dynamic`: moved by the simulation: gravity, contacts, forces, joints.
 * - `kinematic`: moved by the code (`moveTo`), pushes the dynamic bodies
 *   but is not pushed: a platform, a door, a character.
 */
export type BodyType = 'static' | 'dynamic' | 'kinematic';

/** How two colliders combine their coefficients. Default `average`. */
export type CombineRule = 'average' | 'min' | 'max' | 'multiply';

/** What a surface is made of. */
export interface PhysicsMaterial {
  /** Coulomb friction, 0 (ice) and up. Default 0.5. */
  readonly friction?: number;
  /** The bounce, from 0 (none) to 1 (no loss). Default 0. */
  readonly restitution?: number;
  readonly frictionCombine?: CombineRule;
  readonly restitutionCombine?: CombineRule;
}

/**
 * Collision groups: a collider is in the groups of `groups` and collides
 * with those of `mask` (16 bits each); two colliders touch when each is in
 * the mask of the other. By default, in group 1 and colliding with all.
 */
export interface CollisionGroups {
  readonly groups?: number;
  readonly mask?: number;
}

/** A collider: a shape attached to a body, at an offset. */
export interface ColliderDesc extends CollisionGroups {
  readonly shape: Shape;
  /** Relative to the body. */
  readonly position?: Partial<IVec3>;
  readonly rotation?: IQuat;
  readonly material?: PhysicsMaterial;
  /** kg/m³, for the mass of a dynamic body. Default 1. */
  readonly density?: number;
  /**
   * A trigger volume: it reports the colliders entering and leaving it,
   * and pushes nothing.
   */
  readonly sensor?: boolean;
  /** Reports its contacts in `world.events`. Sensors always do. */
  readonly events?: boolean;
  readonly userData?: unknown;
}

/** A body: its type, its pose, its colliders. */
export interface BodyDesc {
  readonly type: BodyType;
  readonly position?: Partial<IVec3>;
  readonly rotation?: IQuat;
  readonly linearVelocity?: Partial<IVec3>;
  readonly angularVelocity?: Partial<IVec3>;
  /** Default 1; 0 floats. */
  readonly gravityScale?: number;
  readonly linearDamping?: number;
  readonly angularDamping?: number;
  /** Continuous collision detection: for the fast and small (bullets). */
  readonly ccd?: boolean;
  /** Whether it falls asleep at rest. Default true. */
  readonly canSleep?: boolean;
  /** Does not turn (a character standing up). */
  readonly lockRotations?: boolean;
  readonly colliders?: readonly ColliderDesc[];
  readonly userData?: unknown;
}

/** The 7 floats of a pose: position x, y, z, then rotation x, y, z, w. */
export const PoseSize = 7;

export interface PhysicsBody {
  readonly world: PhysicsWorld;
  readonly type: BodyType;
  readonly colliders: readonly PhysicsCollider[];
  userData: unknown;

  /** Writes the pose (PoseSize floats) at `offset` of `out`: no allocation. */
  readPose(out: Float32Array | number[], offset?: number): void;
  readonly position: IVec3;
  readonly rotation: IQuat;
  /** Moves it at once (a teleport): no velocity, no push. */
  setPose(position?: Partial<IVec3>, rotation?: IQuat): void;
  /**
   * Kinematic: where the next step takes it, pushing what is in the way;
   * its velocity follows.
   */
  moveTo(position?: Partial<IVec3>, rotation?: IQuat): void;

  linearVelocity: IVec3;
  angularVelocity: IVec3;
  /** An impulse (N·s), at a point of the world (default its center of mass). */
  applyImpulse(impulse: IVec3, point?: IVec3): void;
  /** A force (N) during the next step, at a point of the world. */
  applyForce(force: IVec3, point?: IVec3): void;
  applyTorqueImpulse(impulse: IVec3): void;

  readonly mass: number;
  readonly sleeping: boolean;
  wakeUp(): void;

  addCollider(desc: ColliderDesc): PhysicsCollider;
  removeCollider(collider: PhysicsCollider): void;
}

export interface PhysicsCollider {
  readonly body: PhysicsBody;
  readonly shape: Shape;
  readonly sensor: boolean;
  friction: number;
  restitution: number;
  userData: unknown;
  /** The pose of the collider in the world (PoseSize floats at `offset`). */
  readPose(out: Float32Array | number[], offset?: number): void;
}

/**
 * - `fixed`: the two bodies welded;
 * - `ball`: turning freely around a common point (a chain, a shoulder);
 * - `hinge`: turning around an axis (a door, a wheel), with limits in
 *   radians and a motor;
 * - `slider`: sliding along an axis (a piston), with limits in meters and
 *   a motor.
 */
export type JointType = 'fixed' | 'ball' | 'hinge' | 'slider';

/** A motor of a hinge or a slider: a velocity, or a target position as a spring. */
export interface JointMotor {
  /** Radians or meters per second. */
  readonly velocity?: number;
  /** A target angle or position, with its spring. */
  readonly target?: number;
  readonly stiffness?: number;
  readonly damping?: number;
}

export interface JointDesc {
  readonly type: JointType;
  readonly bodyA: PhysicsBody;
  readonly bodyB: PhysicsBody;
  /** The point joined, in the space of each body. Default their origin. */
  readonly anchorA?: Partial<IVec3>;
  readonly anchorB?: Partial<IVec3>;
  /** Hinge and slider: the axis, in the space of each body (the same for both). Default y. */
  readonly axis?: IVec3;
  /** Hinge and slider: the range of the angle or the position. */
  readonly limits?: readonly [number, number];
  readonly motor?: JointMotor;
  /** Whether the two bodies still collide. Default false. */
  readonly collide?: boolean;
}

export interface PhysicsJoint {
  readonly type: JointType;
  readonly bodyA: PhysicsBody;
  readonly bodyB: PhysicsBody;
  /** The anchors in the world, for the debug view. */
  readAnchors(out: Float32Array | number[], offset?: number): void;
  setLimits(limits: readonly [number, number] | undefined): void;
  setMotor(motor: JointMotor | undefined): void;
}

/** Which colliders a query sees. */
export interface QueryFilter {
  /** Only the colliders of these groups. Default all. */
  readonly mask?: number;
  /** Sees the sensors too. Default false. */
  readonly sensors?: boolean;
  /** Ignores the colliders of this body (the one asking: a character, a gun). */
  readonly exclude?: PhysicsBody;
  /** Ignores the bodies of these types. */
  readonly skip?: readonly BodyType[];
  readonly predicate?: (collider: PhysicsCollider) => boolean;
}

export interface RayHit {
  readonly collider: PhysicsCollider;
  readonly body: PhysicsBody;
  /** Along the ray (its direction normalized). */
  readonly distance: number;
  readonly point: IVec3;
  /** Of the surface hit, toward the ray. */
  readonly normal: IVec3;
}

/** A shape cast: where a shape moved along a direction first touches. */
export type ShapeHit = RayHit;

/** A pair of colliders starting or ending to touch, during the last step. */
export interface ContactEvent {
  readonly type: 'begin' | 'end';
  readonly a: PhysicsCollider;
  readonly b: PhysicsCollider;
  /** One of them is a sensor: an entry, or an exit. */
  readonly sensor: boolean;
}

/** A point of contact, for the debug view. */
export interface ContactPoint {
  readonly point: IVec3;
  /** From a toward b. */
  readonly normal: IVec3;
  readonly depth: number;
  readonly a: PhysicsCollider;
  readonly b: PhysicsCollider;
}

/**
 * A character controller: a kinematic body moved by the code that slides
 * along the walls, climbs the steps and the gentle slopes, and stays on
 * the ground.
 */
export interface CharacterDesc extends CollisionGroups {
  /** Usually a capsule. */
  readonly shape: Shape;
  readonly position?: Partial<IVec3>;
  /** A gap kept to the surfaces, in meters. Default 0.02. */
  readonly offset?: number;
  /** The steepest slope it climbs, in radians. Default 45°. */
  readonly maxSlope?: number;
  /** Climbs steps up to this height (0: none). Default 0.3. */
  readonly stepHeight?: number;
  /** Stays on the ground down to this height (0: none). Default 0.3. */
  readonly snapToGround?: number;
  /** Pushes the dynamic bodies in its way. Default true. */
  readonly pushBodies?: boolean;
}

/** The result of a move of a character. */
export interface CharacterMove {
  /** What was done of the movement asked. */
  readonly movement: IVec3;
  /** On the ground after the move. */
  readonly grounded: boolean;
  /** The colliders hit on the way. */
  readonly collisions: readonly PhysicsCollider[];
}

export interface PhysicsCharacter {
  /** Its kinematic body. */
  readonly body: PhysicsBody;
  /**
   * Moves by `movement` (meters, for this step, gravity included), as far
   * as the obstacles let it; the body gets there at the next step.
   */
  move(movement: IVec3, filter?: QueryFilter): CharacterMove;
  readonly grounded: boolean;
}

export interface WorldOptions {
  /** Default (0, -9.81, 0). */
  readonly gravity?: IVec3;
}

/** A simulated world: its bodies, their joints, the queries. */
export interface PhysicsWorld {
  readonly engine: PhysicsEngine;
  gravity: IVec3;

  createBody(desc: BodyDesc): PhysicsBody;
  /** Removes a body, its colliders and its joints. */
  removeBody(body: PhysicsBody): void;
  readonly bodies: Iterable<PhysicsBody>;

  createJoint(desc: JointDesc): PhysicsJoint;
  removeJoint(joint: PhysicsJoint): void;
  readonly joints: Iterable<PhysicsJoint>;

  createCharacter(desc: CharacterDesc): PhysicsCharacter;
  /** Removes a character and its body. */
  removeCharacter(character: PhysicsCharacter): void;

  /** Advances by `dt` seconds: one fixed step. */
  step(dt: number): void;
  /** The contacts and sensor events of the last step. */
  readonly events: readonly ContactEvent[];
  /** The points of the contacts touching now (debug views). */
  contacts(visit: (contact: ContactPoint) => void): void;

  /** The first collider along a ray (`direction` normalized), within `maxDistance`. */
  raycast(
    origin: IVec3,
    direction: IVec3,
    maxDistance: number,
    filter?: QueryFilter,
  ): RayHit | undefined;
  /** Every collider along a ray, in no particular order; `visit` returns false to stop. */
  raycastAll(
    origin: IVec3,
    direction: IVec3,
    maxDistance: number,
    visit: (hit: RayHit) => boolean | void,
    filter?: QueryFilter,
  ): void;
  /** The first collider a shape moved along `direction` (normalized) touches. */
  shapeCast(
    shape: Shape,
    position: IVec3,
    rotation: IQuat,
    direction: IVec3,
    maxDistance: number,
    filter?: QueryFilter,
  ): ShapeHit | undefined;
  /** The colliders overlapping a shape; `visit` returns false to stop. */
  overlap(
    shape: Shape,
    position: IVec3,
    rotation: IQuat,
    visit: (collider: PhysicsCollider) => boolean | void,
    filter?: QueryFilter,
  ): void;

  /** Frees the world and everything in it. */
  destroy(): void;
}

/** A physics engine: the entry point of an implementation. */
export interface PhysicsEngine {
  /** 'rapier', for instance. */
  readonly name: string;
  createWorld(options?: WorldOptions): PhysicsWorld;
}
