import type { Pose, Skeleton } from '@fdw/engine-animation';
import type { IQuat, IVec3 } from '@fdw/engine-backend';
import {
  type CollisionGroups,
  type PhysicsBody,
  type PhysicsJoint,
  type PhysicsMaterial,
  type PhysicsWorld,
  poseOfMatrix,
  Shapes,
} from '@fdw/engine-physics';

/** A bone of a {@link Ragdoll}: a body on a joint of the skeleton. */
export interface RagdollBone {
  /** The joint the body moves. */
  readonly joint: string;
  /**
   * The joint at the other end of the bone: the body is a capsule from
   * one to the other. Absent: a sphere on the joint (a head, a hand).
   */
  readonly to?: string;
  /** The radius of the capsule or the sphere, in the units of the world. */
  readonly radius: number;
  /** kg/m³. Default 1000 (water: a body). */
  readonly density?: number;
  /**
   * How it hangs on the bone of its nearest ancestor: `ball` (a shoulder,
   * a hip, the spine) or `hinge` (an elbow, a knee). Default `ball`.
   */
  readonly link?: 'ball' | 'hinge';
  /** The axis of a hinge, in the space of the joint. Default x. */
  readonly axis?: IVec3;
  /**
   * The range of a hinge, in radians, around its angle at the activation.
   */
  readonly limits?: readonly [number, number];
}

/** Options of a {@link Ragdoll}. */
export interface RagdollOptions extends CollisionGroups {
  readonly bones: readonly RagdollBone[];
  readonly material?: PhysicsMaterial;
  /** Default 0.05. */
  readonly linearDamping?: number;
  /** Damps the spinning of the limbs. Default 0.5. */
  readonly angularDamping?: number;
}

// A transform of the world: position, rotation, scale.
interface Frame {
  readonly p: Float64Array;
  readonly q: Float64Array;
  readonly s: Float64Array;
}

const newFrame = (): Frame => ({
  p: new Float64Array(3),
  q: new Float64Array([0, 0, 0, 1]),
  s: new Float64Array([1, 1, 1]),
});

// out = a × b.
function mul(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: Float64Array,
): Float64Array {
  const [ax, ay, az, aw] = [a[0], a[1], a[2], a[3]];
  const [bx, by, bz, bw] = [b[0], b[1], b[2], b[3]];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

const conjugate = (q: ArrayLike<number>): Float64Array =>
  new Float64Array([-q[0], -q[1], -q[2], q[3]]);

// v turned by q.
function rotate(
  q: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): Float64Array {
  const [qx, qy, qz, qw] = [q[0], q[1], q[2], q[3]];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

// The rotation taking +y to the direction (x, y, z), normalized.
function fromY(x: number, y: number, z: number): IQuat {
  if (y < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  // The half-way quaternion: (y × d, 1 + y · d), normalized.
  const qx = z;
  const qz = -x;
  const qw = 1 + y;
  const length = Math.hypot(qx, qz, qw);
  return { x: qx / length, y: 0, z: qz / length, w: qw / length };
}

const toVec = (a: ArrayLike<number>): IVec3 => ({ x: a[0], y: a[1], z: a[2] });
const toQuat = (a: ArrayLike<number>): IQuat => ({
  x: a[0],
  y: a[1],
  z: a[2],
  w: a[3],
});

/**
 * A ragdoll: bodies on the bones of a skeleton, linked by joints, which
 * the physics world moves instead of the animation. Activated from the
 * pose of the moment (a character falls as it stood), it gives a pose
 * back at each frame, for the skinning, or to blend with the animation.
 *
 * Written against the abstract physics API: any engine behind it.
 *
 * @example
 * ```ts
 * const ragdoll = new Ragdoll(world, skeleton, { bones: [
 *   { joint: 'hips', to: 'spine', radius: 0.12 },
 *   { joint: 'upperLeg.L', to: 'lowerLeg.L', radius: 0.07 },
 *   { joint: 'lowerLeg.L', to: 'foot.L', radius: 0.06, link: 'hinge', limits: [-2.4, 0] },
 *   // …
 * ] });
 * // The character is hit: the ragdoll takes over.
 * ragdoll.activate(animator.pose, hero.worldMatrix, { x: 0, y: 1, z: -4 });
 * // Each frame, after the step of the world:
 * ragdoll.readPose(pose);
 * ```
 */
export class Ragdoll {
  private readonly _joints: number[];
  private readonly _ends: number[];
  // The bone of each joint of the skeleton, or -1.
  private readonly _boneOf: Int32Array;
  private _bodies: PhysicsBody[] = [];
  private _links: PhysicsJoint[] = [];
  // Per joint, at the activation: its frame in the world, and the
  // rotation of the joint in its body.
  private readonly _frames: Frame[];
  private readonly _offsets: Float64Array[];
  private readonly _node = newFrame();
  private _pose?: Pose;
  private readonly _scratch = new Float64Array(4);
  private readonly _vector = new Float64Array(3);

  constructor(
    readonly world: PhysicsWorld,
    readonly skeleton: Skeleton,
    readonly options: RagdollOptions,
  ) {
    const index = (name: string) => {
      const joint = skeleton.indexOf(name);
      if (joint < 0) {
        throw new Error(`The skeleton has no joint "${name}" for the ragdoll`);
      }
      return joint;
    };
    this._joints = options.bones.map((bone) => index(bone.joint));
    this._ends = options.bones.map((bone) =>
      bone.to !== undefined ? index(bone.to) : -1,
    );
    this._boneOf = new Int32Array(skeleton.count).fill(-1);
    this._joints.forEach((joint, bone) => {
      if (this._boneOf[joint] >= 0) {
        throw new Error(
          `The joint "${skeleton.names[joint]}" has two bones in the ragdoll`,
        );
      }
      this._boneOf[joint] = bone;
    });
    this._frames = Array.from({ length: skeleton.count }, newFrame);
    this._offsets = options.bones.map(() => new Float64Array(4));
  }

  /** Whether the bodies are in the world. */
  get active(): boolean {
    return this._bodies.length > 0;
  }

  /** The bodies, in the order of the bones; none when inactive. */
  get bodies(): readonly PhysicsBody[] {
    return this._bodies;
  }

  /** The body of a joint, when active. */
  bodyOf(joint: string): PhysicsBody | undefined {
    const index = this.skeleton.indexOf(joint);
    const bone = index >= 0 ? this._boneOf[index] : -1;
    return bone >= 0 ? this._bodies[bone] : undefined;
  }

  // The frames of the joints in the world, from a pose and the matrix of
  // the node.
  private framesOf(pose: Pose): void {
    const { parents } = this.skeleton;
    const v = this._vector;
    for (let j = 0; j < this.skeleton.count; j++) {
      const parent = parents[j] >= 0 ? this._frames[parents[j]] : this._node;
      const frame = this._frames[j];
      const t = pose.translations;
      const r = pose.rotations;
      const sc = pose.scales;
      rotate(
        parent.q,
        t[j * 3] * parent.s[0],
        t[j * 3 + 1] * parent.s[1],
        t[j * 3 + 2] * parent.s[2],
        v,
      );
      for (let c = 0; c < 3; c++) {
        frame.p[c] = parent.p[c] + v[c];
        frame.s[c] = parent.s[c] * sc[j * 3 + c];
      }
      mul(
        parent.q,
        [r[j * 4], r[j * 4 + 1], r[j * 4 + 2], r[j * 4 + 3]],
        frame.q,
      );
    }
  }

  /**
   * Puts the bodies in the world, at the pose of the skeleton in the
   * node of world matrix `matrix`, moving at `velocity`. The node stays
   * where it is: {@link readPose} gives the poses relative to it.
   */
  activate(
    pose: Pose,
    matrix: ArrayLike<number>,
    velocity?: Partial<IVec3>,
  ): void {
    this.deactivate();
    const node = this._node;
    const nodePose = new Float32Array(7);
    poseOfMatrix(matrix, nodePose);
    node.p.set(nodePose.subarray(0, 3));
    node.q.set(nodePose.subarray(3, 7));
    node.s[0] = Math.hypot(matrix[0], matrix[1], matrix[2]);
    node.s[1] = Math.hypot(matrix[4], matrix[5], matrix[6]);
    node.s[2] = Math.hypot(matrix[8], matrix[9], matrix[10]);
    this._pose = pose.clone();
    this.framesOf(pose);
    // Every body turned as the node: a hinge axis is then the same in
    // the two bodies it links.
    const inverse = conjugate(node.q);
    const rotation = toQuat(node.q);
    const options = this.options;
    const groups = {
      ...(options.groups !== undefined ? { groups: options.groups } : {}),
      ...(options.mask !== undefined ? { mask: options.mask } : {}),
    };
    const v = this._vector;
    options.bones.forEach((bone, b) => {
      const joint = this._joints[b];
      const frame = this._frames[joint];
      mul(inverse, frame.q, this._offsets[b]);
      const end = this._ends[b];
      let collider;
      if (end >= 0) {
        const to = this._frames[end].p;
        rotate(
          inverse,
          to[0] - frame.p[0],
          to[1] - frame.p[1],
          to[2] - frame.p[2],
          v,
        );
        const length = Math.hypot(v[0], v[1], v[2]);
        const half = length / 2 - bone.radius;
        collider =
          length > 0 && half > 0
            ? {
                shape: Shapes.capsule(half, bone.radius),
                position: { x: v[0] / 2, y: v[1] / 2, z: v[2] / 2 },
                rotation: fromY(v[0] / length, v[1] / length, v[2] / length),
              }
            : {
                shape: Shapes.sphere(bone.radius),
                position: { x: v[0] / 2, y: v[1] / 2, z: v[2] / 2 },
              };
      } else {
        collider = { shape: Shapes.sphere(bone.radius) };
      }
      this._bodies.push(
        this.world.createBody({
          type: 'dynamic',
          position: toVec(frame.p),
          rotation,
          ...(velocity ? { linearVelocity: velocity } : {}),
          linearDamping: options.linearDamping ?? 0.05,
          angularDamping: options.angularDamping ?? 0.5,
          colliders: [
            {
              ...collider,
              density: bone.density ?? 1000,
              ...(options.material ? { material: options.material } : {}),
              ...groups,
            },
          ],
        }),
      );
    });
    // The links, to the bone of the nearest ancestor.
    const { parents } = this.skeleton;
    options.bones.forEach((bone, b) => {
      const joint = this._joints[b];
      let ancestor = parents[joint];
      while (ancestor >= 0 && this._boneOf[ancestor] < 0) {
        ancestor = parents[ancestor];
      }
      if (ancestor < 0) return;
      const a = this._boneOf[ancestor];
      const from = this._frames[ancestor].p;
      const at = this._frames[joint].p;
      const anchor = rotate(
        inverse,
        at[0] - from[0],
        at[1] - from[1],
        at[2] - from[2],
        new Float64Array(3),
      );
      const hinge = bone.link === 'hinge';
      let axis: IVec3 | undefined;
      if (hinge) {
        const local = bone.axis ?? { x: 1, y: 0, z: 0 };
        // The axis of the joint, in the world, then in the bodies.
        const world = rotate(
          this._frames[joint].q,
          local.x,
          local.y,
          local.z,
          new Float64Array(3),
        );
        const inBody = rotate(inverse, world[0], world[1], world[2], world);
        const length = Math.hypot(inBody[0], inBody[1], inBody[2]) || 1;
        axis = {
          x: inBody[0] / length,
          y: inBody[1] / length,
          z: inBody[2] / length,
        };
      }
      this._links.push(
        this.world.createJoint({
          type: hinge ? 'hinge' : 'ball',
          bodyA: this._bodies[a],
          bodyB: this._bodies[b],
          anchorA: toVec(anchor),
          anchorB: { x: 0, y: 0, z: 0 },
          ...(axis ? { axis } : {}),
          ...(hinge && bone.limits ? { limits: bone.limits } : {}),
        }),
      );
    });
  }

  /** Takes the bodies out of the world. */
  deactivate(): void {
    for (const joint of this._links) {
      this.world.removeJoint(joint);
    }
    for (const body of this._bodies) {
      this.world.removeBody(body);
    }
    this._links = [];
    this._bodies = [];
  }

  /**
   * The pose the bodies make, relative to the node at the activation:
   * the joints with a body where their body is, the others as they were
   * at the activation, under their parent. Written into `out`.
   */
  readPose(out: Pose): Pose {
    const pose = this._pose;
    if (!pose || !this.active) {
      if (pose) out.copy(pose);
      return out;
    }
    const { parents } = this.skeleton;
    const frames = this._frames;
    const q = this._scratch;
    const v = this._vector;
    const t = pose.translations;
    const r = pose.rotations;
    for (let j = 0; j < this.skeleton.count; j++) {
      const parent = parents[j] >= 0 ? frames[parents[j]] : this._node;
      const frame = frames[j];
      const bone = this._boneOf[j];
      if (bone >= 0) {
        const body = this._bodies[bone];
        const p = body.position;
        const rotation = body.rotation;
        frame.p[0] = p.x;
        frame.p[1] = p.y;
        frame.p[2] = p.z;
        mul(
          [rotation.x, rotation.y, rotation.z, rotation.w],
          this._offsets[bone],
          frame.q,
        );
        // Local = parent⁻¹ × world.
        const inverse = conjugate(parent.q);
        rotate(
          inverse,
          frame.p[0] - parent.p[0],
          frame.p[1] - parent.p[1],
          frame.p[2] - parent.p[2],
          v,
        );
        for (let c = 0; c < 3; c++) {
          out.translations[j * 3 + c] = v[c] / (parent.s[c] || 1);
          out.scales[j * 3 + c] = pose.scales[j * 3 + c];
        }
        mul(inverse, frame.q, q);
        out.rotations.set(q, j * 4);
      } else {
        // As at the activation, under its parent.
        for (let c = 0; c < 3; c++) {
          out.translations[j * 3 + c] = t[j * 3 + c];
          out.scales[j * 3 + c] = pose.scales[j * 3 + c];
        }
        for (let c = 0; c < 4; c++) out.rotations[j * 4 + c] = r[j * 4 + c];
        rotate(
          parent.q,
          t[j * 3] * parent.s[0],
          t[j * 3 + 1] * parent.s[1],
          t[j * 3 + 2] * parent.s[2],
          v,
        );
        for (let c = 0; c < 3; c++) frame.p[c] = parent.p[c] + v[c];
        mul(
          parent.q,
          [r[j * 4], r[j * 4 + 1], r[j * 4 + 2], r[j * 4 + 3]],
          frame.q,
        );
      }
      for (let c = 0; c < 3; c++) {
        frame.s[c] = parent.s[c] * out.scales[j * 3 + c];
      }
    }
    return out;
  }
}
