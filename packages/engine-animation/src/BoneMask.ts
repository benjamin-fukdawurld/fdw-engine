import type { Skeleton } from './Skeleton';

/**
 * A weight per joint, from 0 to 1: which joints a layer moves. A layer
 * waving the hand masks the upper body; the legs keep walking.
 *
 * @example
 * ```ts
 * const upperBody = BoneMask.branches(skeleton, { Spine: 1, Neck: 0.5 });
 * ```
 */
export class BoneMask {
  constructor(readonly weights: Float32Array) {}

  /** The same weight for every joint. */
  static all(skeleton: Skeleton, weight = 1): BoneMask {
    return new BoneMask(new Float32Array(skeleton.count).fill(weight));
  }

  /**
   * The joints of the branches of the named joints, with their weight; a
   * branch inside another takes its own weight. The other joints: 0.
   */
  static branches(
    skeleton: Skeleton,
    branches: Readonly<Record<string, number>>,
  ): BoneMask {
    const weights = new Float32Array(skeleton.count);
    const set = new Uint8Array(skeleton.count);
    const roots = new Map<number, number>();
    for (const [name, weight] of Object.entries(branches)) {
      roots.set(skeleton.require(name), weight);
    }
    // Parents come first: a joint takes the weight of its closest branch.
    for (let joint = 0; joint < skeleton.count; joint++) {
      const own = roots.get(joint);
      const parent = skeleton.parents[joint];
      if (own !== undefined) {
        weights[joint] = own;
        set[joint] = 1;
      } else if (parent >= 0 && set[parent]) {
        weights[joint] = weights[parent];
        set[joint] = 1;
      }
    }
    return new BoneMask(weights);
  }

  /** 1 − the weights: the rest of the body. */
  inverted(): BoneMask {
    return new BoneMask(this.weights.map((weight) => 1 - weight));
  }
}
