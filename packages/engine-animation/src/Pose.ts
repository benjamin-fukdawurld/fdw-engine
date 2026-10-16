import { composeMatrix, multiplyMatrix, multiplyQuat, nlerp } from './math';

/**
 * The local transforms of the joints of a skeleton: a translation, a
 * rotation (a quaternion x y z w) and a scale per joint, relative to its
 * parent. Three flat arrays, one per channel, in the order of the joints.
 */
export class Pose {
  readonly translations: Float32Array;
  readonly rotations: Float32Array;
  readonly scales: Float32Array;

  /** The identity for every joint. */
  constructor(readonly count: number) {
    this.translations = new Float32Array(count * 3);
    this.rotations = new Float32Array(count * 4);
    this.scales = new Float32Array(count * 3);
    for (let joint = 0; joint < count; joint++) {
      this.rotations[joint * 4 + 3] = 1;
      this.scales.fill(1, joint * 3, joint * 3 + 3);
    }
  }

  /** Copies another pose of the same skeleton. */
  copy(from: Pose): this {
    this.translations.set(from.translations);
    this.rotations.set(from.rotations);
    this.scales.set(from.scales);
    return this;
  }

  clone(): Pose {
    return new Pose(this.count).copy(this);
  }

  /** The translation of a joint. */
  translation(joint: number): [number, number, number] {
    const t = this.translations;
    return [t[joint * 3], t[joint * 3 + 1], t[joint * 3 + 2]];
  }

  /** The rotation of a joint: a quaternion x y z w. */
  rotation(joint: number): [number, number, number, number] {
    const r = this.rotations;
    const i = joint * 4;
    return [r[i], r[i + 1], r[i + 2], r[i + 3]];
  }

  scale(joint: number): [number, number, number] {
    const s = this.scales;
    return [s[joint * 3], s[joint * 3 + 1], s[joint * 3 + 2]];
  }

  /**
   * out = a(1 − w) + bw, joint by joint, w multiplied by the weight of the
   * joint in `mask` when given; the rotations along the shortest arc.
   * `out` may be `a` or `b`.
   */
  static blend(
    a: Pose,
    b: Pose,
    weight: number,
    out: Pose,
    mask?: ArrayLike<number>,
  ): Pose {
    for (let joint = 0; joint < out.count; joint++) {
      const w = mask ? weight * mask[joint] : weight;
      const t3 = joint * 3;
      const r4 = joint * 4;
      if (w <= 0) {
        if (out !== a) {
          copyJoint(a, joint, out);
        }
        continue;
      }
      if (w >= 1) {
        if (out !== b) {
          copyJoint(b, joint, out);
        }
        continue;
      }
      const s = 1 - w;
      for (let k = 0; k < 3; k++) {
        out.translations[t3 + k] =
          a.translations[t3 + k] * s + b.translations[t3 + k] * w;
        out.scales[t3 + k] = a.scales[t3 + k] * s + b.scales[t3 + k] * w;
      }
      nlerp(a.rotations, r4, b.rotations, r4, w, out.rotations, r4);
    }
    return out;
  }

  /**
   * Adds a difference pose ({@link Pose.difference}) to a base, by `weight`
   * (and the weight of each joint in `mask`): the translations add, the
   * rotations compose (the base, then the difference), the scales
   * multiply. `out` may be `base`.
   */
  static add(
    base: Pose,
    additive: Pose,
    weight: number,
    out: Pose,
    mask?: ArrayLike<number>,
  ): Pose {
    const identity = [0, 0, 0, 1];
    const delta = [0, 0, 0, 1];
    for (let joint = 0; joint < out.count; joint++) {
      const w = mask ? weight * mask[joint] : weight;
      const t3 = joint * 3;
      const r4 = joint * 4;
      if (w <= 0) {
        if (out !== base) {
          copyJoint(base, joint, out);
        }
        continue;
      }
      for (let k = 0; k < 3; k++) {
        out.translations[t3 + k] =
          base.translations[t3 + k] + additive.translations[t3 + k] * w;
        out.scales[t3 + k] =
          base.scales[t3 + k] * (1 + (additive.scales[t3 + k] - 1) * w);
      }
      nlerp(identity, 0, additive.rotations, r4, Math.min(w, 1), delta, 0);
      multiplyQuat(base.rotations, r4, delta, 0, out.rotations, r4);
    }
    return out;
  }

  /**
   * The difference that brings `reference` to `pose`, for an additive
   * layer: pose − reference for the translations, reference⁻¹ × pose for
   * the rotations, pose / reference for the scales.
   */
  static difference(pose: Pose, reference: Pose, out: Pose): Pose {
    const inverse = [0, 0, 0, 1];
    for (let joint = 0; joint < out.count; joint++) {
      const t3 = joint * 3;
      const r4 = joint * 4;
      for (let k = 0; k < 3; k++) {
        out.translations[t3 + k] =
          pose.translations[t3 + k] - reference.translations[t3 + k];
        const s = reference.scales[t3 + k];
        out.scales[t3 + k] = s === 0 ? 1 : pose.scales[t3 + k] / s;
      }
      const r = reference.rotations;
      inverse[0] = -r[r4];
      inverse[1] = -r[r4 + 1];
      inverse[2] = -r[r4 + 2];
      inverse[3] = r[r4 + 3];
      multiplyQuat(inverse, 0, pose.rotations, r4, out.rotations, r4);
    }
    return out;
  }

  /** The local matrix of each joint, column-major, 16 numbers a joint. */
  localMatrices(out = new Float32Array(this.count * 16)): Float32Array {
    for (let joint = 0; joint < this.count; joint++) {
      composeMatrix(
        this.translations,
        joint * 3,
        this.rotations,
        joint * 4,
        this.scales,
        joint * 3,
        out,
        joint * 16,
      );
    }
    return out;
  }

  /**
   * The matrix of each joint in the space of the skeleton: its local
   * matrix after those of its ancestors. `parents`: the parent of each
   * joint (-1 for the roots), before it in the order of the joints.
   */
  modelMatrices(
    parents: ArrayLike<number>,
    out = new Float32Array(this.count * 16),
  ): Float32Array {
    const local = new Float32Array(16);
    for (let joint = 0; joint < this.count; joint++) {
      const parent = parents[joint];
      const target = parent < 0 ? out : local;
      const offset = parent < 0 ? joint * 16 : 0;
      composeMatrix(
        this.translations,
        joint * 3,
        this.rotations,
        joint * 4,
        this.scales,
        joint * 3,
        target,
        offset,
      );
      if (parent >= 0) {
        multiplyMatrix(out, parent * 16, local, 0, out, joint * 16);
      }
    }
    return out;
  }
}

function copyJoint(from: Pose, joint: number, to: Pose): void {
  const t3 = joint * 3;
  const r4 = joint * 4;
  for (let k = 0; k < 3; k++) {
    to.translations[t3 + k] = from.translations[t3 + k];
    to.scales[t3 + k] = from.scales[t3 + k];
  }
  for (let k = 0; k < 4; k++) {
    to.rotations[r4 + k] = from.rotations[r4 + k];
  }
}
