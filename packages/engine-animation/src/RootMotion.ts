import type { AnimationClip } from './AnimationClip';
import { multiplyQuat } from './math';
import { Pose } from './Pose';
import type { Skeleton } from './Skeleton';

/**
 * What the animator takes from the clips to move the character: the
 * movement of a joint (the hips, or a root joint under them), removed from
 * the poses.
 *
 * @group Root motion
 */
export interface RootMotionOptions {
  /** The joint that carries the movement: its name or its index. */
  readonly joint: string | number;
  /**
   * Takes the turns too: the rotation of the joint around y. Default
   * false: the poses keep their turns, the movement has none.
   */
  readonly rotation?: boolean;
  /**
   * Takes the vertical movement too (a jump, a climb). Default false: the
   * poses keep their height (the bob of the steps), the movement has none.
   */
  readonly vertical?: boolean;
}

/**
 * The movement of the last update of an {@link Animator}, in the space of
 * the character as it faced at the start of the update: meters (in the
 * units of the skeleton) along x, y, z, radians around y. The blends,
 * cross-fades and loops of the graph are in it; the layers are not (the
 * movement comes from their base).
 *
 * @group Root motion
 */
export interface RootMotion {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// Where the joint is at a time of a clip, in the space of the skeleton.
interface State {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const newState = (): State => ({ x: 0, y: 0, z: 0, yaw: 0 });

const wrapAngle = (angle: number): number =>
  angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

// The angle of the rotation (x, y, z, w) around y: the twist of a
// swing-twist decomposition.
const yawOf = (q: ArrayLike<number>, i: number): number =>
  2 * Math.atan2(q[i + 1], q[i + 3]);

// The cycles a single move may cross, as for the events.
const maxCycles = 8;

/**
 * Takes the movement of a joint out of the clips: what it travels between
 * two times, and the pose kept in place. One per animator; the clips are
 * shared.
 *
 * @internal
 */
export class RootMotionExtractor {
  readonly joint: number;
  readonly rotation: boolean;
  readonly vertical: boolean;
  // The rest transform of the parent of the joint, in the space of the
  // skeleton: its 3×3 (positions), its inverse, its translation, its
  // rotation and the inverse of it.
  private readonly _m = new Float64Array(9);
  private readonly _mInverse = new Float64Array(9);
  private readonly _t = new Float64Array(3);
  private readonly _q = new Float64Array([0, 0, 0, 1]);
  private readonly _qInverse = new Float64Array([0, 0, 0, 1]);
  private readonly _pose: Pose;
  private readonly _rest: Pose;
  private readonly _starts = new WeakMap<AnimationClip, State>();
  private readonly _a = newState();
  private readonly _b = newState();
  private readonly _segment = newState();
  private readonly _total = newState();
  private readonly _quat = new Float64Array(4);

  constructor(skeleton: Skeleton, options: RootMotionOptions) {
    const joint =
      typeof options.joint === 'number'
        ? options.joint
        : skeleton.indexOf(options.joint);
    if (joint < 0 || joint >= skeleton.count) {
      throw new Error(
        `The skeleton has no joint "${String(options.joint)}" for the root motion`,
      );
    }
    this.joint = joint;
    this.rotation = options.rotation ?? false;
    this.vertical = options.vertical ?? false;
    this._rest = skeleton.rest;
    this._pose = skeleton.rest.clone();
    const parent = skeleton.parents[joint];
    if (parent >= 0) {
      const matrices = skeleton.rest.modelMatrices(skeleton.parents);
      const o = parent * 16;
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
          this._m[c * 3 + r] = matrices[o + c * 4 + r];
        }
        this._t[c] = matrices[o + 12 + c];
      }
      invert3(this._m, this._mInverse);
      // The rotation of the parent: those of its ancestors, root first.
      const chain: number[] = [];
      for (let j = parent; j >= 0; j = skeleton.parents[j]) chain.unshift(j);
      for (const j of chain) {
        multiplyQuat(this._q, 0, skeleton.rest.rotations, j * 4, this._q, 0);
      }
      const q = this._q;
      const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      for (let k = 0; k < 4; k++) q[k] /= length;
      this._qInverse.set([-q[0], -q[1], -q[2], q[3]]);
    } else {
      this._m.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      this._mInverse.set(this._m);
    }
  }

  // The joint at `time` of a clip, in the space of the skeleton.
  private state(clip: AnimationClip, time: number, out: State): State {
    const pose = this._pose;
    const j = this.joint;
    const t3 = j * 3;
    const r4 = j * 4;
    for (let k = 0; k < 3; k++) {
      pose.translations[t3 + k] = this._rest.translations[t3 + k];
    }
    for (let k = 0; k < 4; k++) {
      pose.rotations[r4 + k] = this._rest.rotations[r4 + k];
    }
    clip.sampleJoint(time, j, pose);
    const t = pose.translations;
    const m = this._m;
    const x = t[t3];
    const y = t[t3 + 1];
    const z = t[t3 + 2];
    out.x = m[0] * x + m[3] * y + m[6] * z + this._t[0];
    out.y = m[1] * x + m[4] * y + m[7] * z + this._t[1];
    out.z = m[2] * x + m[5] * y + m[8] * z + this._t[2];
    if (this.rotation) {
      multiplyQuat(this._q, 0, pose.rotations, r4, this._quat, 0);
      out.yaw = yawOf(this._quat, 0);
    } else {
      out.yaw = 0;
    }
    return out;
  }

  private start(clip: AnimationClip): State {
    let start = this._starts.get(clip);
    if (!start) {
      start = this.state(clip, 0, newState());
      this._starts.set(clip, start);
    }
    return start;
  }

  // The movement from a to b (two times within the clip), in the space of
  // the character facing as at a.
  private segment(clip: AnimationClip, a: number, b: number): State {
    const s0 = this.state(clip, a, this._a);
    const s1 = this.state(clip, b, this._b);
    const out = this._segment;
    const dx = s1.x - s0.x;
    const dz = s1.z - s0.z;
    out.y = this.vertical ? s1.y - s0.y : 0;
    if (this.rotation) {
      out.yaw = wrapAngle(s1.yaw - s0.yaw);
      // The character turned by yaw(a) − yaw(0) since the start of the clip.
      const facing = s0.yaw - this.start(clip).yaw;
      const c = Math.cos(facing);
      const s = Math.sin(facing);
      // The inverse of the rotation around y by `facing`.
      out.x = c * dx - s * dz;
      out.z = s * dx + c * dz;
    } else {
      out.yaw = 0;
      out.x = dx;
      out.z = dz;
    }
    return out;
  }

  // total, then segment: the segment turned by the yaw of the total.
  private compose(total: State, segment: State): void {
    const c = Math.cos(total.yaw);
    const s = Math.sin(total.yaw);
    total.x += c * segment.x + s * segment.z;
    total.y += segment.y;
    total.z += -s * segment.x + c * segment.z;
    total.yaw += segment.yaw;
  }

  /**
   * Adds to `out`, weighted, the movement of a clip from `from` (within the
   * clip) to `to` (unwrapped: past the end or before 0 when it loops).
   */
  accumulate(
    clip: AnimationClip,
    from: number,
    to: number,
    loop: boolean,
    weight: number,
    out: RootMotion,
  ): void {
    const length = clip.duration;
    const total = this._total;
    total.x = total.y = total.z = total.yaw = 0;
    if (!loop || length <= 0) {
      const a = Math.min(Math.max(from, 0), length);
      const b = Math.min(Math.max(to, 0), length);
      if (a !== b) this.compose(total, this.segment(clip, a, b));
    } else {
      let cycles = 0;
      while (to >= length && cycles < maxCycles) {
        this.compose(total, this.segment(clip, from, length));
        from = 0;
        to -= length;
        cycles++;
      }
      while (to < 0 && cycles < maxCycles) {
        this.compose(total, this.segment(clip, from, 0));
        from = length;
        to += length;
        cycles++;
      }
      to = Math.min(Math.max(to, 0), length);
      if (from !== to) this.compose(total, this.segment(clip, from, to));
    }
    out.x += total.x * weight;
    out.y += total.y * weight;
    out.z += total.z * weight;
    out.yaw += total.yaw * weight;
  }

  /**
   * Keeps the joint of a pose sampled at `time` in place: where it is at
   * the start of the clip, along x and z (and y when vertical), facing as
   * at the start (when it takes the rotations).
   */
  strip(clip: AnimationClip, time: number, pose: Pose): void {
    const start = this.start(clip);
    const now = this.state(clip, time, this._a);
    const j = this.joint;
    const dx = start.x - now.x;
    const dy = this.vertical ? start.y - now.y : 0;
    const dz = start.z - now.z;
    const mi = this._mInverse;
    const t = pose.translations;
    t[j * 3] += mi[0] * dx + mi[3] * dy + mi[6] * dz;
    t[j * 3 + 1] += mi[1] * dx + mi[4] * dy + mi[7] * dz;
    t[j * 3 + 2] += mi[2] * dx + mi[5] * dy + mi[8] * dz;
    if (this.rotation) {
      // local' = parent⁻¹ × turn × parent × local, the turn around y
      // bringing the joint back to its facing at the start.
      const half = wrapAngle(start.yaw - now.yaw) / 2;
      const q = this._quat;
      const r4 = j * 4;
      multiplyQuat(this._q, 0, pose.rotations, r4, q, 0);
      const turn = [0, Math.sin(half), 0, Math.cos(half)];
      multiplyQuat(turn, 0, q, 0, q, 0);
      multiplyQuat(this._qInverse, 0, q, 0, pose.rotations, r4);
    }
  }
}

/**
 * The movement of a root motion in the world: `motion` (in the space of
 * the character) turned by the facing of the character (`yaw`, radians
 * around y) and scaled by its scale. Its yaw adds to the facing.
 *
 * @example
 * ```ts
 * animator.update(dt);
 * const step = rootMotionToWorld(animator.rootMotion, heading);
 * controller.move(step);
 * heading += animator.rootMotion.yaw;
 * ```
 *
 * @group Root motion
 */
export function rootMotionToWorld(
  motion: Readonly<RootMotion>,
  yaw: number,
  scale = 1,
  out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.x = (c * motion.x + s * motion.z) * scale;
  out.y = motion.y * scale;
  out.z = (-s * motion.x + c * motion.z) * scale;
  return out;
}

function invert3(m: Float64Array, out: Float64Array): void {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = det !== 0 ? 1 / det : 0;
  out[0] = A * k;
  out[1] = -(b * i - c * h) * k;
  out[2] = (b * f - c * e) * k;
  out[3] = B * k;
  out[4] = (a * i - c * g) * k;
  out[5] = -(a * f - c * d) * k;
  out[6] = C * k;
  out[7] = -(a * h - b * g) * k;
  out[8] = (a * e - b * d) * k;
}
