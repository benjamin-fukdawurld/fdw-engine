import { describe, expect, it } from 'vitest';
import { AnimationClip } from './AnimationClip';
import { Animator } from './Animator';
import { AnimationGraphBuilder } from './graph/AnimationGraphBuilder';
import { rootMotionToWorld } from './RootMotion';
import { Skeleton } from './Skeleton';
import { testSkeleton } from './testSkeleton';

const HIPS = 1;

// The hips walking 2 m along +z in `duration` seconds, at a height of 1.
const walk = (duration = 1, distance = 2) =>
  new AnimationClip({
    name: 'walk',
    tracks: [
      {
        joint: HIPS,
        path: 'translation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, duration]),
        values: new Float32Array([0, 1, 0, 0, 1, distance]),
      },
    ],
  });

// The hips turning a quarter to the left (around +y) while going forward.
const turn = () => {
  const s = Math.sin(Math.PI / 4);
  const c = Math.cos(Math.PI / 4);
  return new AnimationClip({
    name: 'turn',
    tracks: [
      {
        joint: HIPS,
        path: 'rotation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, s, 0, c]),
      },
      {
        joint: HIPS,
        path: 'translation',
        interpolation: 'LINEAR',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 1, 0, 0, 1, 1]),
      },
    ],
  });
};

const single = (clip: string, loop = true) => {
  const g = new AnimationGraphBuilder('test');
  g.output(g.clip(clip, { loop }));
  return g.build();
};

describe('root motion', () => {
  it('takes the movement of the hips and keeps the pose in place', () => {
    const skeleton = testSkeleton();
    const animator = new Animator(single('walk'), {
      skeleton,
      clips: [walk()],
      rootMotion: { joint: 'hips' },
    });
    animator.update(0.25);
    expect(animator.rootMotion.z).toBeCloseTo(0.5);
    expect(animator.rootMotion.x).toBeCloseTo(0);
    expect(animator.rootMotion.yaw).toBe(0);
    expect(animator.pose.translation(HIPS)).toEqual([0, 1, 0]);
  });

  it('adds the whole clip at each loop', () => {
    const animator = new Animator(single('walk'), {
      skeleton: testSkeleton(),
      clips: [walk()],
      rootMotion: { joint: HIPS },
    });
    animator.update(0.75);
    animator.update(0.5);
    // From 0.75 to 1 (0.5 m), then from 0 to 0.25 (0.5 m).
    expect(animator.rootMotion.z).toBeCloseTo(1);
    animator.update(2.5);
    expect(animator.rootMotion.z).toBeCloseTo(5);
  });

  it('stops at the end of a clip that does not loop', () => {
    const animator = new Animator(single('walk', false), {
      skeleton: testSkeleton(),
      clips: [walk()],
      rootMotion: { joint: HIPS },
    });
    animator.update(0.9);
    animator.update(0.5);
    expect(animator.rootMotion.z).toBeCloseTo(0.2);
    animator.update(0.5);
    expect(animator.rootMotion.z).toBe(0);
  });

  it('blends the movements as the poses', () => {
    const g = new AnimationGraphBuilder('test');
    g.parameter('speed', 'number', 0.5);
    g.output(g.blend(g.clip('slow'), g.clip('fast'), g.param('speed')));
    const animator = new Animator(g.build(), {
      skeleton: testSkeleton(),
      clips: {
        slow: walk(1, 1),
        fast: walk(1, 3),
      },
      rootMotion: { joint: HIPS },
    });
    animator.update(0.5);
    expect(animator.rootMotion.z).toBeCloseTo(0.5 * 0.5 + 1.5 * 0.5);
  });

  it('leaves the layers out and the vertical movement unless asked', () => {
    const g = new AnimationGraphBuilder('test');
    g.output(g.layer(g.clip('walk'), g.clip('jump'), { weight: 1 }));
    const jump = new AnimationClip({
      name: 'jump',
      tracks: [
        {
          joint: HIPS,
          path: 'translation',
          interpolation: 'LINEAR',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 1, 0, 0, 2, 4]),
        },
      ],
    });
    const animator = new Animator(g.build(), {
      skeleton: testSkeleton(),
      clips: [walk(), jump],
      rootMotion: { joint: HIPS },
    });
    animator.update(0.5);
    expect(animator.rootMotion.z).toBeCloseTo(1);
    expect(animator.rootMotion.y).toBe(0);
    // The layer replaces the hips: kept in place along z, its height kept.
    expect(animator.pose.translation(HIPS)[1]).toBeCloseTo(1.5);
    expect(animator.pose.translation(HIPS)[2]).toBeCloseTo(0);

    const vertical = new Animator(single('jump'), {
      skeleton: testSkeleton(),
      clips: [jump],
      rootMotion: { joint: HIPS, vertical: true },
    });
    vertical.update(0.5);
    expect(vertical.rootMotion.y).toBeCloseTo(0.5);
    expect(vertical.pose.translation(HIPS)).toEqual([0, 1, 0]);
  });

  it('takes the turns, the steps in the space of the character', () => {
    const animator = new Animator(single('turn'), {
      skeleton: testSkeleton(),
      clips: [turn()],
      rootMotion: { joint: HIPS, rotation: true },
    });
    animator.update(0.5);
    expect(animator.rootMotion.yaw).toBeCloseTo(Math.PI / 4);
    expect(animator.rootMotion.z).toBeCloseTo(0.5);
    // Kept facing as at the start.
    const [, y, , w] = animator.pose.rotation(HIPS);
    expect(y).toBeCloseTo(0);
    expect(w).toBeCloseTo(1);
    // The second half: +z in the clip is now 45° to the right of the
    // facing of the character.
    animator.update(0.5);
    expect(animator.rootMotion.yaw).toBeCloseTo(Math.PI / 4);
    expect(animator.rootMotion.z).toBeCloseTo(0.5 * Math.cos(Math.PI / 4));
    expect(animator.rootMotion.x).toBeCloseTo(-0.5 * Math.sin(Math.PI / 4));
  });

  it('reads the movement in the space of the skeleton, under a parent', () => {
    // An armature turned a quarter around x and scaled by 0.01: the clip
    // moves the hips along its local +y, which is +z of the skeleton.
    const s = Math.SQRT1_2;
    const skeleton = new Skeleton([
      { name: 'armature', rotation: [s, 0, 0, s], scale: [0.01, 0.01, 0.01] },
      { name: 'hips', parent: 0 },
    ]);
    const clip = new AnimationClip({
      name: 'walk',
      tracks: [
        {
          joint: 1,
          path: 'translation',
          interpolation: 'LINEAR',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 0, 100, 0, 200, 100]),
        },
      ],
    });
    const animator = new Animator(single('walk'), {
      skeleton,
      clips: [clip],
      rootMotion: { joint: 'hips' },
    });
    animator.update(0.5);
    expect(animator.rootMotion.z).toBeCloseTo(1);
    expect(animator.rootMotion.y).toBeCloseTo(0);
    const [x, y, z] = animator.pose.translation(1);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(100);
  });

  it('turns the movement into the world', () => {
    const out = rootMotionToWorld({ x: 0, y: 0, z: 1, yaw: 0 }, Math.PI / 2, 2);
    expect(out.x).toBeCloseTo(2);
    expect(out.z).toBeCloseTo(0);
  });

  it('refuses an unknown joint', () => {
    expect(
      () =>
        new Animator(single('walk'), {
          skeleton: testSkeleton(),
          clips: [walk()],
          rootMotion: { joint: 'tail' },
        }),
    ).toThrow(/no joint "tail"/);
  });
});
