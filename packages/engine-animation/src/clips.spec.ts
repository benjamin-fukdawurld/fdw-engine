import { describe, expect, it } from 'vitest';
import { additiveClip, AnimationClip } from './AnimationClip';
import { BoneMask } from './BoneMask';
import { Pose } from './Pose';
import { Skeleton } from './Skeleton';
import { testSkeleton } from './testSkeleton';

const close = (actual: ArrayLike<number>, expected: readonly number[]) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 5));

// A quaternion of `angle` radians about y.
const aboutY = (angle: number) =>
  [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)] as const;

describe('Skeleton', () => {
  it('takes the nodes of a model depth first, and knows their nodes', () => {
    const skeleton = Skeleton.fromHierarchy({
      nodes: [
        { name: 'scene', children: [2] },
        { name: 'hand', children: [] },
        { name: 'body', translation: [0, 1, 0], children: [1] },
      ],
      roots: [0],
    });
    expect(skeleton.names).toEqual(['scene', 'body', 'hand']);
    expect([...skeleton.parents]).toEqual([-1, 0, 1]);
    expect(skeleton.jointOf(1)).toBe(2);
    expect(skeleton.jointOf(7)).toBe(-1);
    expect(skeleton.rest.translation(1)).toEqual([0, 1, 0]);
    expect(
      Skeleton.fromHierarchy(
        { nodes: [{ children: [1] }, { children: [] }], roots: [0] },
        { root: 1 },
      ).names,
    ).toEqual(['node 1']);
  });

  it('refuses a joint before its parent', () => {
    expect(
      () => new Skeleton([{ name: 'a', parent: 1 }, { name: 'b' }]),
    ).toThrow('must come after its parent');
    expect(() => testSkeleton().require('tail')).toThrow('no joint "tail"');
    expect(testSkeleton().isWithin(3, 1)).toBe(true);
    expect(testSkeleton().isWithin(4, 2)).toBe(false);
  });
});

describe('Pose', () => {
  it('blends joint by joint, along the shortest arc, with a mask', () => {
    const a = new Pose(2);
    const b = new Pose(2);
    b.translations.set([2, 0, 0, 4, 0, 0]);
    // The opposite quaternion of a quarter turn: the same rotation.
    b.rotations.set(
      aboutY(Math.PI / 2).map((v) => -v),
      0,
    );
    b.rotations.set(aboutY(Math.PI / 2), 4);
    const out = Pose.blend(a, b, 0.5, new Pose(2), [1, 0.5]);
    close(out.translations, [1, 0, 0, 1, 0, 0]);
    close(out.rotation(0), aboutY(Math.PI / 4));
    // A quarter of the way, normalized: nlerp, not slerp.
    const [, y, , w] = aboutY(Math.PI / 2);
    const length = Math.hypot(0.25 * y, 0.75 + 0.25 * w);
    close(out.rotation(1), [
      0,
      (0.25 * y) / length,
      0,
      (0.75 + 0.25 * w) / length,
    ]);
  });

  it('adds the difference of two poses', () => {
    const skeleton = testSkeleton();
    const nod = skeleton.rest.clone();
    nod.rotations.set(aboutY(0.4), 2 * 4);
    nod.translations[2 * 3 + 1] += 0.1;
    const difference = Pose.difference(nod, skeleton.rest, new Pose(5));
    const base = skeleton.rest.clone();
    base.rotations.set(aboutY(0.2), 2 * 4);
    const out = Pose.add(base, difference, 1, new Pose(5));
    close(out.rotation(2), aboutY(0.6));
    close(out.translation(2), [0, 0.6, 0]);
    // Half the difference.
    close(
      Pose.add(base, difference, 0.5, new Pose(5)).rotation(2),
      aboutY(0.4),
    );
    // The joints without difference keep the base.
    close(out.translation(4), [0.1, -0.5, 0]);
  });

  it('computes the matrices of the joints in the space of the skeleton', () => {
    const skeleton = testSkeleton();
    const pose = skeleton.rest.clone();
    // The spine turns a quarter about y: the arm goes from +x to -z.
    pose.rotations.set(aboutY(Math.PI / 2), 2 * 4);
    const matrices = pose.modelMatrices(skeleton.parents);
    close(matrices.subarray(3 * 16 + 12, 3 * 16 + 15), [0, 1.8, -0.3]);
    close(matrices.subarray(4 * 16 + 12, 4 * 16 + 15), [0.1, 0.5, 0]);
  });
});

describe('AnimationClip', () => {
  const track = (
    path: 'translation' | 'rotation' | 'scale',
    interpolation: 'STEP' | 'LINEAR' | 'CUBICSPLINE',
    times: number[],
    values: number[],
  ) => ({
    joint: 1,
    path,
    interpolation,
    times: new Float32Array(times),
    values: new Float32Array(values),
  });

  it('interpolates linearly, the rotations spherically, and holds the ends', () => {
    const clip = new AnimationClip({
      name: 'turn',
      tracks: [
        track('translation', 'LINEAR', [0, 2], [0, 0, 0, 4, 0, 0]),
        track('rotation', 'LINEAR', [0, 2], [...aboutY(0), ...aboutY(2)]),
      ],
    });
    expect(clip.duration).toBe(2);
    const pose = clip.sample(0.5, new Pose(2));
    close(pose.translation(1), [1, 0, 0]);
    close(pose.rotation(1), aboutY(0.5));
    close(clip.sample(-1, pose).translation(1), [0, 0, 0]);
    close(clip.sample(5, pose).translation(1), [4, 0, 0]);
    // The joints without track are left alone.
    close(pose.translation(0), [0, 0, 0]);
  });

  it('steps, and follows cubic splines', () => {
    const step = new AnimationClip({
      name: 'step',
      tracks: [track('scale', 'STEP', [0, 1], [1, 1, 1, 3, 3, 3])],
    });
    close(step.sample(0.99, new Pose(2)).scale(1), [1, 1, 1]);
    close(step.sample(1, new Pose(2)).scale(1), [3, 3, 3]);
    // Flat tangents: the smoothstep between the values.
    const cubic = new AnimationClip({
      name: 'cubic',
      tracks: [
        track(
          'translation',
          'CUBICSPLINE',
          [0, 1],
          [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0],
        ),
      ],
    });
    close(cubic.sample(0.25, new Pose(2)).translation(1), [0.3125, 0, 0]);
    close(cubic.sample(0.5, new Pose(2)).translation(1), [1, 0, 0]);
  });

  it('refuses tracks whose values do not match their keys', () => {
    expect(
      () =>
        new AnimationClip({
          name: 'bad',
          tracks: [track('rotation', 'LINEAR', [0, 1], [0, 0, 0, 1])],
        }),
    ).toThrow('a rotation track of 2 keys needs 8 values, got 4');
  });

  it('maps the channels of a model to the joints, without the weights', () => {
    const skeleton = Skeleton.fromHierarchy({
      nodes: [
        { name: 'a', children: [1] },
        { name: 'b', children: [] },
      ],
      roots: [0],
    });
    const channel = (node: number, path: 'translation' | 'weights') => ({
      node,
      path,
      interpolation: 'LINEAR' as const,
      times: new Float32Array([0, 1]),
      values: new Float32Array(
        path === 'weights' ? [0, 1] : [0, 0, 0, 1, 0, 0],
      ),
    });
    const clip = AnimationClip.fromData(
      {
        name: 'Walk',
        duration: 1.5,
        channels: [
          channel(1, 'translation'),
          channel(0, 'weights'),
          channel(9, 'translation'),
        ],
      },
      skeleton,
      {
        events: [
          { time: 1, name: 'b' },
          { time: 0.5, name: 'a' },
        ],
      },
    );
    expect(clip.name).toBe('Walk');
    expect(clip.duration).toBe(1.5);
    expect(clip.tracks.map((t) => t.joint)).toEqual([1]);
    expect(clip.events.map((e) => e.name)).toEqual(['a', 'b']);
    const seen: string[] = [];
    clip.eventsBetween(0.5, 1, (event) => seen.push(event.name));
    expect(seen).toEqual(['b']);
  });

  it('makes a clip additive: its difference with its first pose', () => {
    const skeleton = testSkeleton();
    const clip = new AnimationClip({
      name: 'nod',
      tracks: [
        track('rotation', 'LINEAR', [0, 1], [...aboutY(0.3), ...aboutY(0.8)]),
      ],
    });
    const additive = additiveClip(clip, skeleton);
    const difference = additive.sample(1, new Pose(5));
    close(difference.rotation(1), aboutY(0.5));
    close(additive.sample(0, new Pose(5)).rotation(1), aboutY(0));
  });
});

describe('BoneMask', () => {
  it('weighs the branches, the inner ones with their own weight', () => {
    const skeleton = testSkeleton();
    const mask = BoneMask.branches(skeleton, { spine: 1, arm: 0.5 });
    expect([...mask.weights]).toEqual([0, 0, 1, 0.5, 0]);
    expect([...mask.inverted().weights]).toEqual([1, 1, 0, 0.5, 1]);
    expect([...BoneMask.all(skeleton).weights]).toEqual([1, 1, 1, 1, 1]);
  });
});
