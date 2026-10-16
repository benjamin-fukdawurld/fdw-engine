import { normalizeQuat, slerp } from './math';
import { Pose } from './Pose';
import type { Skeleton } from './Skeleton';

/** How the values between two keys are computed, as in glTF. */
export type Interpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';

/** The channels of a joint a track animates. */
export type TrackPath = 'translation' | 'rotation' | 'scale';

/** The keys of a channel of a joint. */
export interface Track {
  readonly joint: number;
  readonly path: TrackPath;
  readonly interpolation: Interpolation;
  /** Seconds, increasing. */
  readonly times: Float32Array;
  /**
   * 3 or 4 numbers a key (4 for the rotations); with `CUBICSPLINE`, the
   * in-tangent, the value and the out-tangent of each key.
   */
  readonly values: Float32Array;
}

/** A moment of a clip: a footstep, the hit of a sword. */
export interface AnimationEvent {
  /** Seconds from the start of the clip. */
  readonly time: number;
  readonly name: string;
  readonly data?: unknown;
}

/**
 * An animation as read from a model: the shape of `AnimationClipData` of
 * engine-assets (a glTF animation), whose channels target nodes.
 */
export interface ClipData {
  readonly name?: string;
  readonly duration: number;
  readonly channels: readonly {
    readonly node: number;
    readonly path: TrackPath | 'weights';
    readonly interpolation: Interpolation;
    readonly times: Float32Array;
    readonly values: Float32Array;
  }[];
}

const sizes: Record<TrackPath, number> = {
  translation: 3,
  rotation: 4,
  scale: 3,
};

/**
 * An animation of the joints of a skeleton: tracks of keys, sampled at any
 * time, and events. Shared by all the characters of the skeleton.
 *
 * @example
 * ```ts
 * const walk = AnimationClip.fromData(model.data.animations[0], skeleton, {
 *   events: [{ time: 0.1, name: 'step' }, { time: 0.6, name: 'step' }],
 * });
 * walk.sample(0.25, pose);
 * ```
 */
export class AnimationClip {
  readonly name: string;
  /** Seconds: the last key, unless given longer. */
  readonly duration: number;
  readonly tracks: readonly Track[];
  /** Sorted by time. */
  readonly events: readonly AnimationEvent[];

  constructor({
    name,
    duration,
    tracks,
    events = [],
  }: {
    name: string;
    duration?: number;
    tracks: readonly Track[];
    events?: readonly AnimationEvent[];
  }) {
    for (const track of tracks) {
      const size = sizes[track.path];
      const keys = track.times.length;
      const expected =
        keys * size * (track.interpolation === 'CUBICSPLINE' ? 3 : 1);
      if (keys === 0 || track.values.length !== expected) {
        throw new Error(
          `Clip "${name}": a ${track.path} track of ${keys} keys needs ${expected} values, got ${track.values.length}`,
        );
      }
    }
    this.name = name;
    this.tracks = tracks;
    this.duration =
      duration ??
      tracks.reduce(
        (max, track) => Math.max(max, track.times[track.times.length - 1]),
        0,
      );
    this.events = [...events].sort((a, b) => a.time - b.time);
  }

  /**
   * A clip of a model, its channels mapped to the joints of the skeleton
   * by their node. Channels whose node is not a joint, and the weights of
   * the morph targets, are left out.
   */
  static fromData(
    data: ClipData,
    skeleton: Skeleton,
    options: { name?: string; events?: readonly AnimationEvent[] } = {},
  ): AnimationClip {
    const tracks: Track[] = [];
    for (const channel of data.channels) {
      const joint = skeleton.jointOf(channel.node);
      if (joint < 0 || channel.path === 'weights') {
        continue;
      }
      tracks.push({
        joint,
        path: channel.path,
        interpolation: channel.interpolation,
        times: channel.times,
        values: channel.values,
      });
    }
    return new AnimationClip({
      name: options.name ?? data.name ?? 'clip',
      duration: data.duration,
      tracks,
      ...(options.events ? { events: options.events } : {}),
    });
  }

  /** The same clip with these events. */
  withEvents(events: readonly AnimationEvent[]): AnimationClip {
    return new AnimationClip({
      name: this.name,
      duration: this.duration,
      tracks: this.tracks,
      events,
    });
  }

  /**
   * Writes the values of the tracks at `time` (clamped to the keys) into
   * `pose`; the joints and channels without track keep their values: copy
   * the rest pose first.
   */
  sample(time: number, pose: Pose): Pose {
    for (const track of this.tracks) {
      sampleTrack(track, time, pose);
    }
    return pose;
  }

  /**
   * Calls `visit` for the events after `from` up to `to` (seconds, from <
   * to, within the clip): (from, to]. An event at 0 is reached from below
   * 0, after a loop.
   */
  eventsBetween(
    from: number,
    to: number,
    visit: (event: AnimationEvent) => void,
  ): void {
    for (const event of this.events) {
      if (event.time > to) {
        break;
      }
      if (event.time > from) {
        visit(event);
      }
    }
  }
}

// The key before `time`: times[k] <= time < times[k + 1].
function keyBefore(times: Float32Array, time: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle] <= time) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function sampleTrack(track: Track, time: number, pose: Pose): void {
  const { times, values, interpolation, path } = track;
  const size = sizes[path];
  const target =
    path === 'translation'
      ? pose.translations
      : path === 'rotation'
        ? pose.rotations
        : pose.scales;
  const out = track.joint * size;
  const last = times.length - 1;
  // A key holds three values with CUBICSPLINE: the value is the second.
  const stride = interpolation === 'CUBICSPLINE' ? size * 3 : size;
  const valueAt = interpolation === 'CUBICSPLINE' ? size : 0;
  if (time <= times[0] || last === 0) {
    target.set(values.subarray(valueAt, valueAt + size), out);
    return;
  }
  if (time >= times[last]) {
    const start = last * stride + valueAt;
    target.set(values.subarray(start, start + size), out);
    return;
  }
  const k = keyBefore(times, time);
  const t0 = times[k];
  const dt = times[k + 1] - t0;
  const t = dt > 0 ? (time - t0) / dt : 0;
  switch (interpolation) {
    case 'STEP':
      target.set(values.subarray(k * size, k * size + size), out);
      return;
    case 'LINEAR':
      if (size === 4) {
        slerp(values, k * 4, values, (k + 1) * 4, t, target, out);
        return;
      }
      for (let c = 0; c < size; c++) {
        const a = values[k * size + c];
        target[out + c] = a + (values[(k + 1) * size + c] - a) * t;
      }
      return;
    case 'CUBICSPLINE': {
      // Hermite: the value and out-tangent of k, the in-tangent and the
      // value of k + 1, the tangents scaled by the time between the keys.
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const a = k * stride;
      const b = (k + 1) * stride;
      for (let c = 0; c < size; c++) {
        target[out + c] =
          h00 * values[a + size + c] +
          h10 * dt * values[a + 2 * size + c] +
          h01 * values[b + size + c] +
          h11 * dt * values[b + c];
      }
      if (size === 4) {
        normalizeQuat(target, out);
      }
      return;
    }
  }
}

/**
 * The difference between each pose of a clip and a reference pose (its
 * first one by default), for an additive layer: a clip of nodding made
 * additive nods whatever the base pose.
 */
export function additiveClip(
  clip: AnimationClip,
  skeleton: Skeleton,
  reference?: Pose,
): AnimationClip {
  const base =
    reference ?? clip.sample(0, new Pose(skeleton.count).copy(skeleton.rest));
  const pose = new Pose(skeleton.count);
  const difference = new Pose(skeleton.count);
  const tracks = clip.tracks.map((track): Track => {
    const size = sizes[track.path];
    const keys = track.times.length;
    // The tangents of a cubic spline do not subtract: sampled linearly.
    const values = new Float32Array(keys * size);
    for (let k = 0; k < keys; k++) {
      pose.copy(skeleton.rest);
      sampleTrack(track, track.times[k], pose);
      Pose.difference(pose, base, difference);
      const source =
        track.path === 'translation'
          ? difference.translations
          : track.path === 'rotation'
            ? difference.rotations
            : difference.scales;
      values.set(
        source.subarray(track.joint * size, track.joint * size + size),
        k * size,
      );
    }
    return {
      joint: track.joint,
      path: track.path,
      interpolation:
        track.interpolation === 'CUBICSPLINE' ? 'LINEAR' : track.interpolation,
      times: track.times,
      values,
    };
  });
  return new AnimationClip({
    name: clip.name,
    duration: clip.duration,
    tracks,
    events: clip.events,
  });
}
