import { bench, describe } from 'vitest';
import { AnimationClip, type Track } from './AnimationClip';
import { Animator } from './Animator';
import { BoneMask } from './BoneMask';
import { AnimationGraphBuilder } from './graph/AnimationGraphBuilder';
import { Skeleton } from './Skeleton';

// CPU cost of a character per frame: a skeleton of 18 joints (the
// character of the tutorial), clips of 30 keys per second on every joint,
// the graph of the tutorial (a blend space of three clips, a state machine,
// a layer on a mask), blending walk and run.
const joints = 18;
const skeleton = new Skeleton(
  Array.from({ length: joints }, (_, i) => ({
    name: `joint ${i}`,
    parent: i === 0 ? -1 : Math.floor((i - 1) / 2),
    translation: [0, 0.2, 0] as const,
  })),
);
const clip = (name: string, duration: number) => {
  const keys = Math.round(duration * 30) + 1;
  const times = Float32Array.from({ length: keys }, (_, k) => k / 30);
  const tracks: Track[] = [];
  for (let joint = 0; joint < joints; joint++) {
    const values = new Float32Array(keys * 4);
    for (let k = 0; k < keys; k++) {
      const angle = Math.sin((k / keys) * Math.PI * 2 + joint) * 0.5;
      values.set([Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)], k * 4);
    }
    tracks.push({
      joint,
      path: 'rotation',
      interpolation: 'LINEAR',
      times,
      values,
    });
  }
  return new AnimationClip({ name, tracks });
};
const clips = [
  clip('Idle', 3),
  clip('Walk', 1.1),
  clip('Run', 0.66),
  clip('Jump', 1),
  clip('Wave', 1.2),
];

const g = new AnimationGraphBuilder('character');
g.parameter('speed', 'number', 2.4);
g.parameter('jump', 'trigger');
const locomotion = g.blend1d(
  [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
  [0, 1.3, 3.6],
  g.param('speed'),
);
const body = g.stateMachine({
  states: { locomotion, jump: g.clip('Jump', { loop: false }) },
  transitions: [{ from: 'locomotion', to: 'jump', trigger: 'jump' }],
});
g.output(g.layer(body, g.clip('Wave'), { mask: 'arm', weight: 1 }));
const animator = new Animator(g.build(), {
  skeleton,
  clips,
  masks: { arm: BoneMask.branches(skeleton, { 'joint 2': 1 }) },
});
const matrices = new Float32Array(joints * 16);

describe('a character of 18 joints, per frame', () => {
  bench('Animator.update', () => {
    animator.update(1 / 60);
  });
  bench('Animator.update and the model matrices', () => {
    animator.update(1 / 60).modelMatrices(skeleton.parents, matrices);
  });
});
