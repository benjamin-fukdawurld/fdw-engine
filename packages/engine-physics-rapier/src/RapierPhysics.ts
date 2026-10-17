import RAPIER from '@dimforge/rapier3d-compat';
import type { IQuat, IVec3 } from '@fdw/engine-backend';
import type {
  BodyDesc,
  BodyType,
  CharacterDesc,
  CharacterMove,
  ColliderDesc,
  CombineRule,
  ContactEvent,
  ContactPoint,
  JointDesc,
  JointMotor,
  JointType,
  PhysicsBody,
  PhysicsCharacter,
  PhysicsCollider,
  PhysicsEngine,
  PhysicsJoint,
  PhysicsWorld,
  QueryFilter,
  RayHit,
  Shape,
  ShapeHit,
  WorldOptions,
} from '@fdw/engine-physics';

// The abstract physics API of @fdw/engine-physics on Rapier
// (https://rapier.rs), compiled to WebAssembly: the same module in the
// browser and in Node (the native demos).

type Rapier = typeof RAPIER;

let ready: Promise<void> | undefined;

/**
 * The Rapier engine, once its WebAssembly module is loaded (once per
 * page or process).
 */
export async function createRapierPhysics(): Promise<RapierPhysics> {
  ready ??= RAPIER.init();
  await ready;
  return new RapierPhysics(RAPIER);
}

export class RapierPhysics implements PhysicsEngine {
  readonly name = 'rapier';

  /** @internal Use createRapierPhysics(). */
  constructor(readonly rapier: Rapier) {}

  /** The version of Rapier. */
  get version(): string {
    return this.rapier.version();
  }

  createWorld(options: WorldOptions = {}): RapierWorld {
    return new RapierWorld(this, options);
  }
}

const identity: IQuat = { x: 0, y: 0, z: 0, w: 1 };

const vec = (v: Partial<IVec3> | undefined): IVec3 => ({
  x: v?.x ?? 0,
  y: v?.y ?? 0,
  z: v?.z ?? 0,
});

const combineRules: Record<CombineRule, RAPIER.CoefficientCombineRule> = {
  average: RAPIER.CoefficientCombineRule.Average,
  min: RAPIER.CoefficientCombineRule.Min,
  max: RAPIER.CoefficientCombineRule.Max,
  multiply: RAPIER.CoefficientCombineRule.Multiply,
};

// Collision groups: the groups in the 16 high bits, the mask in the low.
const interactionGroups = (groups = 1, mask = 0xffff): number =>
  ((groups & 0xffff) << 16) | (mask & 0xffff);

function rotate(q: IQuat, v: IVec3): IVec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function multiply(a: IQuat, b: IQuat): IQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

const conjugate = (q: IQuat): IQuat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/** The collider description of Rapier for a shape. */
function shapeDesc(shape: Shape): RAPIER.ColliderDesc {
  const C = RAPIER.ColliderDesc;
  switch (shape.type) {
    case 'sphere':
      return C.ball(shape.radius);
    case 'box': {
      const { x, y, z } = shape.halfExtents;
      return C.cuboid(x, y, z);
    }
    case 'capsule':
      return C.capsule(shape.halfHeight, shape.radius);
    case 'cylinder':
      return C.cylinder(shape.halfHeight, shape.radius);
    case 'convex': {
      let desc: RAPIER.ColliderDesc | null = null;
      try {
        desc = shape.indices
          ? C.convexMesh(shape.points, shape.indices)
          : C.convexHull(shape.points);
      } catch {
        // Too few points: Rapier fails inside its module.
      }
      if (!desc) {
        throw new Error('The points of the convex shape have no hull');
      }
      return desc;
    }
    case 'mesh':
      return C.trimesh(shape.vertices, shape.indices);
    case 'heightfield': {
      // Rapier: (rows - 1) × (columns - 1) cells, the heights by columns.
      const { rows, columns, heights, size } = shape;
      const byColumns = new Float32Array(rows * columns);
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          byColumns[column * rows + row] = heights[row * columns + column];
        }
      }
      return C.heightfield(rows - 1, columns - 1, byColumns, {
        x: size.x,
        y: size.y,
        z: size.z,
      });
    }
  }
}

const bodyTypes: Record<number, BodyType> = {
  [RAPIER.RigidBodyType.Fixed]: 'static',
  [RAPIER.RigidBodyType.Dynamic]: 'dynamic',
  [RAPIER.RigidBodyType.KinematicPositionBased]: 'kinematic',
  [RAPIER.RigidBodyType.KinematicVelocityBased]: 'kinematic',
};

export class RapierBody implements PhysicsBody {
  userData: unknown;
  /** @internal */
  readonly _colliders: RapierCollider[] = [];

  /** @internal */
  constructor(
    readonly world: RapierWorld,
    /** The body of Rapier. */
    readonly raw: RAPIER.RigidBody,
    userData: unknown,
  ) {
    this.userData = userData;
  }

  get type(): BodyType {
    return bodyTypes[this.raw.bodyType()];
  }

  get colliders(): readonly PhysicsCollider[] {
    return this._colliders;
  }

  readPose(out: Float32Array | number[], offset = 0): void {
    const t = this.raw.translation();
    const r = this.raw.rotation();
    out[offset] = t.x;
    out[offset + 1] = t.y;
    out[offset + 2] = t.z;
    out[offset + 3] = r.x;
    out[offset + 4] = r.y;
    out[offset + 5] = r.z;
    out[offset + 6] = r.w;
  }

  get position(): IVec3 {
    const { x, y, z } = this.raw.translation();
    return { x, y, z };
  }

  get rotation(): IQuat {
    const { x, y, z, w } = this.raw.rotation();
    return { x, y, z, w };
  }

  setPose(position?: Partial<IVec3>, rotation?: IQuat): void {
    if (position) {
      this.raw.setTranslation({ ...this.position, ...position }, true);
    }
    if (rotation) {
      this.raw.setRotation(rotation, true);
    }
  }

  moveTo(position?: Partial<IVec3>, rotation?: IQuat): void {
    if (position) {
      this.raw.setNextKinematicTranslation({ ...this.position, ...position });
    }
    if (rotation) {
      this.raw.setNextKinematicRotation(rotation);
    }
  }

  get linearVelocity(): IVec3 {
    const { x, y, z } = this.raw.linvel();
    return { x, y, z };
  }

  set linearVelocity(velocity: IVec3) {
    this.raw.setLinvel(velocity, true);
  }

  get angularVelocity(): IVec3 {
    const { x, y, z } = this.raw.angvel();
    return { x, y, z };
  }

  set angularVelocity(velocity: IVec3) {
    this.raw.setAngvel(velocity, true);
  }

  applyImpulse(impulse: IVec3, point?: IVec3): void {
    if (point) {
      this.raw.applyImpulseAtPoint(impulse, point, true);
    } else {
      this.raw.applyImpulse(impulse, true);
    }
  }

  applyForce(force: IVec3, point?: IVec3): void {
    if (point) {
      this.raw.addForceAtPoint(force, point, true);
    } else {
      this.raw.addForce(force, true);
    }
    // Rapier keeps the forces until reset: after the next step.
    this.world._forced.add(this);
  }

  applyTorqueImpulse(impulse: IVec3): void {
    this.raw.applyTorqueImpulse(impulse, true);
  }

  get mass(): number {
    return this.raw.mass();
  }

  get sleeping(): boolean {
    return this.raw.isSleeping();
  }

  wakeUp(): void {
    this.raw.wakeUp();
  }

  addCollider(desc: ColliderDesc): PhysicsCollider {
    return this.world._createCollider(this, desc);
  }

  removeCollider(collider: PhysicsCollider): void {
    this.world._removeCollider(collider as RapierCollider);
  }
}

export class RapierCollider implements PhysicsCollider {
  userData: unknown;

  /** @internal */
  constructor(
    readonly body: RapierBody,
    readonly shape: Shape,
    /** The collider of Rapier. */
    readonly raw: RAPIER.Collider,
    userData: unknown,
  ) {
    this.userData = userData;
  }

  get sensor(): boolean {
    return this.raw.isSensor();
  }

  get friction(): number {
    return this.raw.friction();
  }

  set friction(friction: number) {
    this.raw.setFriction(friction);
  }

  get restitution(): number {
    return this.raw.restitution();
  }

  set restitution(restitution: number) {
    this.raw.setRestitution(restitution);
  }

  readPose(out: Float32Array | number[], offset = 0): void {
    const t = this.raw.translation();
    const r = this.raw.rotation();
    out[offset] = t.x;
    out[offset + 1] = t.y;
    out[offset + 2] = t.z;
    out[offset + 3] = r.x;
    out[offset + 4] = r.y;
    out[offset + 5] = r.z;
    out[offset + 6] = r.w;
  }
}

export class RapierJoint implements PhysicsJoint {
  /** @internal */
  constructor(
    readonly type: JointType,
    readonly bodyA: RapierBody,
    readonly bodyB: RapierBody,
    /** The joint of Rapier. */
    readonly raw: RAPIER.ImpulseJoint,
  ) {}

  readAnchors(out: Float32Array | number[], offset = 0): void {
    const anchors: [RapierBody, IVec3][] = [
      [this.bodyA, this.raw.anchor1()],
      [this.bodyB, this.raw.anchor2()],
    ];
    for (const [body, anchor] of anchors) {
      const p = body.position;
      const a = rotate(body.rotation, anchor);
      out[offset++] = p.x + a.x;
      out[offset++] = p.y + a.y;
      out[offset++] = p.z + a.z;
    }
  }

  setLimits(limits: readonly [number, number] | undefined): void {
    const joint = this.unit();
    if (limits) {
      joint.setLimits(limits[0], limits[1]);
    } else {
      // No way to turn them off: as wide as can be.
      joint.setLimits(-Infinity, Infinity);
    }
  }

  setMotor(motor: JointMotor | undefined): void {
    const joint = this.unit();
    if (!motor) {
      joint.configureMotorVelocity(0, 0);
    } else if (motor.target !== undefined) {
      joint.configureMotor(
        motor.target,
        motor.velocity ?? 0,
        motor.stiffness ?? 1000,
        motor.damping ?? 100,
      );
    } else {
      joint.configureMotorVelocity(motor.velocity ?? 0, motor.damping ?? 10);
    }
  }

  private unit(): RAPIER.UnitImpulseJoint {
    if (this.type !== 'hinge' && this.type !== 'slider') {
      throw new Error(`A ${this.type} joint has no limits nor motor`);
    }
    return this.raw as RAPIER.UnitImpulseJoint;
  }
}

export class RapierCharacter implements PhysicsCharacter {
  private _grounded = false;

  /** @internal */
  constructor(
    readonly body: RapierBody,
    private readonly _collider: RapierCollider,
    /** The controller of Rapier. */
    readonly raw: RAPIER.KinematicCharacterController,
  ) {}

  get grounded(): boolean {
    return this._grounded;
  }

  move(movement: IVec3, filter?: QueryFilter): CharacterMove {
    const query = this.body.world._filter(filter);
    this.raw.computeColliderMovement(
      this._collider.raw,
      movement,
      query.flags,
      query.groups,
      query.predicate,
    );
    const { x, y, z } = this.raw.computedMovement();
    this._grounded = this.raw.computedGrounded();
    const collisions: PhysicsCollider[] = [];
    for (let i = 0; i < this.raw.numComputedCollisions(); i++) {
      const handle = this.raw.computedCollision(i)?.collider?.handle;
      const collider =
        handle === undefined
          ? undefined
          : this.body.world._colliders.get(handle);
      if (collider && !collisions.includes(collider)) {
        collisions.push(collider);
      }
    }
    const p = this.body.position;
    this.body.raw.setNextKinematicTranslation({
      x: p.x + x,
      y: p.y + y,
      z: p.z + z,
    });
    return { movement: { x, y, z }, grounded: this._grounded, collisions };
  }
}

/** The filter of a query, in the terms of Rapier. */
interface RawFilter {
  readonly flags: number | undefined;
  readonly groups: number | undefined;
  readonly body: RAPIER.RigidBody | undefined;
  readonly predicate: ((collider: RAPIER.Collider) => boolean) | undefined;
}

export class RapierWorld implements PhysicsWorld {
  /** The world of Rapier. */
  readonly raw: RAPIER.World;
  /** @internal */
  readonly _colliders = new Map<number, RapierCollider>();
  /** @internal */
  readonly _forced = new Set<RapierBody>();
  private readonly _bodies = new Map<number, RapierBody>();
  private readonly _joints = new Set<RapierJoint>();
  private readonly _characters = new Set<RapierCharacter>();
  private readonly _queue: RAPIER.EventQueue;
  private _events: ContactEvent[] = [];

  /** @internal Use engine.createWorld(). */
  constructor(
    readonly engine: RapierPhysics,
    { gravity = { x: 0, y: -9.81, z: 0 } }: WorldOptions = {},
  ) {
    this.raw = new RAPIER.World(gravity);
    this._queue = new RAPIER.EventQueue(true);
  }

  get gravity(): IVec3 {
    const { x, y, z } = this.raw.gravity;
    return { x, y, z };
  }

  set gravity(gravity: IVec3) {
    this.raw.gravity = { x: gravity.x, y: gravity.y, z: gravity.z };
  }

  get bodies(): Iterable<PhysicsBody> {
    return this._bodies.values();
  }

  get joints(): Iterable<PhysicsJoint> {
    return this._joints.values();
  }

  get events(): readonly ContactEvent[] {
    return this._events;
  }

  createBody(desc: BodyDesc): RapierBody {
    const D = RAPIER.RigidBodyDesc;
    const raw =
      desc.type === 'static'
        ? D.fixed()
        : desc.type === 'dynamic'
          ? D.dynamic()
          : D.kinematicPositionBased();
    const p = vec(desc.position);
    raw.setTranslation(p.x, p.y, p.z);
    raw.setRotation(desc.rotation ?? identity);
    const v = vec(desc.linearVelocity);
    raw.setLinvel(v.x, v.y, v.z);
    raw.setAngvel(vec(desc.angularVelocity));
    raw.setGravityScale(desc.gravityScale ?? 1);
    raw.setLinearDamping(desc.linearDamping ?? 0);
    raw.setAngularDamping(desc.angularDamping ?? 0);
    raw.setCcdEnabled(desc.ccd ?? false);
    raw.setCanSleep(desc.canSleep ?? true);
    if (desc.lockRotations) {
      raw.lockRotations();
    }
    const body = new RapierBody(
      this,
      this.raw.createRigidBody(raw),
      desc.userData,
    );
    this._bodies.set(body.raw.handle, body);
    for (const collider of desc.colliders ?? []) {
      this._createCollider(body, collider);
    }
    return body;
  }

  removeBody(body: PhysicsBody): void {
    const rapierBody = body as RapierBody;
    if (this._bodies.get(rapierBody.raw.handle) !== rapierBody) {
      return;
    }
    for (const joint of [...this._joints]) {
      if (joint.bodyA === body || joint.bodyB === body) {
        this._joints.delete(joint);
      }
    }
    for (const collider of rapierBody._colliders) {
      this._colliders.delete(collider.raw.handle);
    }
    this._forced.delete(rapierBody);
    this._bodies.delete(rapierBody.raw.handle);
    // Its colliders and joints with it.
    this.raw.removeRigidBody(rapierBody.raw);
  }

  /** @internal */
  _createCollider(body: RapierBody, desc: ColliderDesc): RapierCollider {
    const raw = shapeDesc(desc.shape);
    const p = vec(desc.position);
    raw.setTranslation(p.x, p.y, p.z);
    raw.setRotation(desc.rotation ?? identity);
    const material = desc.material ?? {};
    raw.setFriction(material.friction ?? 0.5);
    raw.setRestitution(material.restitution ?? 0);
    raw.setFrictionCombineRule(
      combineRules[material.frictionCombine ?? 'average'],
    );
    raw.setRestitutionCombineRule(
      combineRules[material.restitutionCombine ?? 'average'],
    );
    raw.setDensity(desc.density ?? 1);
    raw.setSensor(desc.sensor ?? false);
    raw.setCollisionGroups(interactionGroups(desc.groups, desc.mask));
    if (desc.events || desc.sensor) {
      raw.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
    if (desc.sensor) {
      // Entered by the kinematic bodies too: the characters.
      raw.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    }
    let created: RAPIER.Collider;
    try {
      created = this.raw.createCollider(raw, body.raw);
    } catch {
      // A degenerate shape (a hull of points in a plane): Rapier fails
      // inside its module.
      throw new Error(`The ${desc.shape.type} shape has no hull or volume`);
    }
    const collider = new RapierCollider(
      body,
      desc.shape,
      created,
      desc.userData,
    );
    body._colliders.push(collider);
    this._colliders.set(collider.raw.handle, collider);
    return collider;
  }

  /** @internal */
  _removeCollider(collider: RapierCollider): void {
    const { _colliders: colliders } = collider.body;
    const index = colliders.indexOf(collider);
    if (index < 0) {
      return;
    }
    colliders.splice(index, 1);
    this._colliders.delete(collider.raw.handle);
    this.raw.removeCollider(collider.raw, true);
  }

  createJoint(desc: JointDesc): RapierJoint {
    const bodyA = desc.bodyA as RapierBody;
    const bodyB = desc.bodyB as RapierBody;
    const a = vec(desc.anchorA);
    const b = vec(desc.anchorB);
    const axis = desc.axis ?? { x: 0, y: 1, z: 0 };
    const J = RAPIER.JointData;
    let data: RAPIER.JointData;
    switch (desc.type) {
      case 'fixed':
        // Welded as they are: the rotation of A in the frame of B.
        data = J.fixed(
          a,
          identity,
          b,
          multiply(conjugate(bodyB.rotation), bodyA.rotation),
        );
        break;
      case 'ball':
        data = J.spherical(a, b);
        break;
      case 'hinge':
        data = J.revolute(a, b, axis);
        break;
      case 'slider':
        data = J.prismatic(a, b, axis);
        break;
    }
    const raw = this.raw.createImpulseJoint(data, bodyA.raw, bodyB.raw, true);
    raw.setContactsEnabled(desc.collide ?? false);
    const joint = new RapierJoint(desc.type, bodyA, bodyB, raw);
    // Set on the joint: those of the JointData are ignored.
    if (desc.limits) {
      joint.setLimits(desc.limits);
    }
    if (desc.motor) {
      joint.setMotor(desc.motor);
    }
    this._joints.add(joint);
    return joint;
  }

  removeJoint(joint: PhysicsJoint): void {
    const rapierJoint = joint as RapierJoint;
    if (this._joints.delete(rapierJoint)) {
      this.raw.removeImpulseJoint(rapierJoint.raw, true);
    }
  }

  createCharacter(desc: CharacterDesc): RapierCharacter {
    const body = this.createBody({
      type: 'kinematic',
      position: desc.position,
    });
    const collider = this._createCollider(body, {
      shape: desc.shape,
      groups: desc.groups,
      mask: desc.mask,
    });
    const raw = this.raw.createCharacterController(desc.offset ?? 0.02);
    const maxSlope = desc.maxSlope ?? Math.PI / 4;
    raw.setMaxSlopeClimbAngle(maxSlope);
    raw.setMinSlopeSlideAngle(maxSlope);
    const step = desc.stepHeight ?? 0.3;
    if (step > 0) {
      raw.enableAutostep(step, 0.1, true);
    }
    const snap = desc.snapToGround ?? 0.3;
    if (snap > 0) {
      raw.enableSnapToGround(snap);
    }
    raw.setApplyImpulsesToDynamicBodies(desc.pushBodies ?? true);
    const character = new RapierCharacter(body, collider, raw);
    this._characters.add(character);
    return character;
  }

  removeCharacter(character: PhysicsCharacter): void {
    const rapierCharacter = character as RapierCharacter;
    if (this._characters.delete(rapierCharacter)) {
      this.raw.removeCharacterController(rapierCharacter.raw);
      this.removeBody(rapierCharacter.body);
    }
  }

  step(dt: number): void {
    this.raw.timestep = dt;
    this.raw.step(this._queue);
    for (const body of this._forced) {
      body.raw.resetForces(false);
    }
    this._forced.clear();
    const events: ContactEvent[] = [];
    this._queue.drainCollisionEvents((handle1, handle2, started) => {
      const a = this._colliders.get(handle1);
      const b = this._colliders.get(handle2);
      if (a && b) {
        events.push({
          type: started ? 'begin' : 'end',
          a,
          b,
          sensor: a.sensor || b.sensor,
        });
      }
    });
    this._events = events;
  }

  contacts(visit: (contact: ContactPoint) => void): void {
    const seen = new Set<string>();
    for (const a of this._colliders.values()) {
      if (a.body.type === 'static') {
        continue;
      }
      this.raw.contactPairsWith(a.raw, (other) => {
        const b = this._colliders.get(other.handle);
        const key =
          a.raw.handle < other.handle
            ? `${a.raw.handle},${other.handle}`
            : `${other.handle},${a.raw.handle}`;
        if (!b || seen.has(key)) {
          return;
        }
        seen.add(key);
        this.raw.contactPair(a.raw, other, (manifold, flipped) => {
          const n = manifold.normal();
          const sign = flipped ? -1 : 1;
          const normal = { x: n.x * sign, y: n.y * sign, z: n.z * sign };
          for (let i = 0; i < manifold.numSolverContacts(); i++) {
            const point = manifold.solverContactPoint(i);
            if (point) {
              visit({
                point: { x: point.x, y: point.y, z: point.z },
                normal,
                depth: -manifold.solverContactDist(i),
                a,
                b,
              });
            }
          }
        });
      });
    }
  }

  raycast(
    origin: IVec3,
    direction: IVec3,
    maxDistance: number,
    filter?: QueryFilter,
  ): RayHit | undefined {
    const query = this._filter(filter);
    const hit = this.raw.castRayAndGetNormal(
      new RAPIER.Ray(origin, direction),
      maxDistance,
      true,
      query.flags,
      query.groups,
      undefined,
      query.body,
      query.predicate,
    );
    return hit
      ? this.rayHit(
          origin,
          direction,
          hit.collider,
          hit.timeOfImpact,
          hit.normal,
        )
      : undefined;
  }

  raycastAll(
    origin: IVec3,
    direction: IVec3,
    maxDistance: number,
    visit: (hit: RayHit) => boolean | void,
    filter?: QueryFilter,
  ): void {
    const query = this._filter(filter);
    this.raw.intersectionsWithRay(
      new RAPIER.Ray(origin, direction),
      maxDistance,
      true,
      (hit) => {
        const result = this.rayHit(
          origin,
          direction,
          hit.collider,
          hit.timeOfImpact,
          hit.normal,
        );
        return !result || visit(result) !== false;
      },
      query.flags,
      query.groups,
      undefined,
      query.body,
      query.predicate,
    );
  }

  shapeCast(
    shape: Shape,
    position: IVec3,
    rotation: IQuat,
    direction: IVec3,
    maxDistance: number,
    filter?: QueryFilter,
  ): ShapeHit | undefined {
    const query = this._filter(filter);
    const hit = this.raw.castShape(
      position,
      rotation,
      direction,
      shapeDesc(shape).shape,
      0,
      maxDistance,
      true,
      query.flags,
      query.groups,
      undefined,
      query.body,
      query.predicate,
    );
    const collider = hit && this._colliders.get(hit.collider.handle);
    if (!hit || !collider) {
      return undefined;
    }
    // The witness and the normal on the collider hit, in the world.
    const { witness1: point, normal1: normal } = hit;
    return {
      collider,
      body: collider.body,
      distance: hit.time_of_impact,
      point: { x: point.x, y: point.y, z: point.z },
      normal: { x: normal.x, y: normal.y, z: normal.z },
    };
  }

  overlap(
    shape: Shape,
    position: IVec3,
    rotation: IQuat,
    visit: (collider: PhysicsCollider) => boolean | void,
    filter?: QueryFilter,
  ): void {
    const query = this._filter(filter);
    this.raw.intersectionsWithShape(
      position,
      rotation,
      shapeDesc(shape).shape,
      (raw) => {
        const collider = this._colliders.get(raw.handle);
        return !collider || visit(collider) !== false;
      },
      query.flags,
      query.groups,
      undefined,
      query.body,
      query.predicate,
    );
  }

  destroy(): void {
    for (const character of this._characters) {
      this.raw.removeCharacterController(character.raw);
    }
    this._characters.clear();
    this._bodies.clear();
    this._colliders.clear();
    this._joints.clear();
    this._queue.free();
    this.raw.free();
  }

  /** @internal */
  _filter(filter: QueryFilter = {}): RawFilter {
    const F = RAPIER.QueryFilterFlags;
    let flags = filter.sensors ? 0 : F.EXCLUDE_SENSORS;
    for (const type of filter.skip ?? []) {
      flags |=
        type === 'static'
          ? F.EXCLUDE_FIXED
          : type === 'dynamic'
            ? F.EXCLUDE_DYNAMIC
            : F.EXCLUDE_KINEMATIC;
    }
    const { predicate } = filter;
    return {
      flags,
      groups:
        filter.mask === undefined
          ? undefined
          : interactionGroups(0xffff, filter.mask),
      body: (filter.exclude as RapierBody | undefined)?.raw,
      predicate: predicate
        ? (raw) => {
            const collider = this._colliders.get(raw.handle);
            return !!collider && predicate(collider);
          }
        : undefined,
    };
  }

  private rayHit(
    origin: IVec3,
    direction: IVec3,
    raw: RAPIER.Collider,
    distance: number,
    normal: IVec3,
  ): RayHit | undefined {
    const collider = this._colliders.get(raw.handle);
    return (
      collider && {
        collider,
        body: collider.body,
        distance,
        point: {
          x: origin.x + direction.x * distance,
          y: origin.y + direction.y * distance,
          z: origin.z + direction.z * distance,
        },
        normal: { x: normal.x, y: normal.y, z: normal.z },
      }
    );
  }
}
