import { Skeleton } from '@fdw/engine-animation';
import { Shapes } from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { describe, expect, it } from 'vitest';
import { Ragdoll, type RagdollBone } from './Ragdoll';

// A small body: the hips at 1 m, a spine, a head, two legs.
const skeleton = () =>
  new Skeleton([
    { name: 'root' },
    { name: 'hips', parent: 0, translation: [0, 1, 0] },
    { name: 'spine', parent: 1, translation: [0, 0.3, 0] },
    { name: 'head', parent: 2, translation: [0, 0.4, 0] },
    { name: 'upperLeg.L', parent: 1, translation: [0.1, -0.05, 0] },
    { name: 'lowerLeg.L', parent: 4, translation: [0, -0.45, 0] },
    { name: 'foot.L', parent: 5, translation: [0, -0.45, 0] },
    { name: 'upperLeg.R', parent: 1, translation: [-0.1, -0.05, 0] },
    { name: 'lowerLeg.R', parent: 7, translation: [0, -0.45, 0] },
    { name: 'foot.R', parent: 8, translation: [0, -0.45, 0] },
  ]);

const bones: RagdollBone[] = [
  { joint: 'hips', to: 'spine', radius: 0.12 },
  { joint: 'spine', to: 'head', radius: 0.12 },
  { joint: 'head', radius: 0.1 },
  ...(['L', 'R'] as const).flatMap((side): RagdollBone[] => [
    { joint: `upperLeg.${side}`, to: `lowerLeg.${side}`, radius: 0.07 },
    {
      joint: `lowerLeg.${side}`,
      to: `foot.${side}`,
      radius: 0.06,
      link: 'hinge',
      limits: [0, 2.4],
    },
  ]),
];

// The node of the character: 2 m along x, a quarter turn around y.
const matrix = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0, 1];

const world = async () => {
  const engine = await createRapierPhysics();
  const w = engine.createWorld();
  w.createBody({
    type: 'static',
    position: { y: -0.5 },
    colliders: [{ shape: Shapes.box(10, 0.5, 10) }],
  });
  return w;
};

describe('Ragdoll', () => {
  it('puts a body on each bone, where the pose has its joint', async () => {
    const w = await world();
    const sk = skeleton();
    const ragdoll = new Ragdoll(w, sk, { bones });
    expect(ragdoll.active).toBe(false);
    ragdoll.activate(sk.rest, matrix);
    expect(ragdoll.active).toBe(true);
    expect(ragdoll.bodies.length).toBe(bones.length);
    // The left leg: +x of the character, turned to −z of the world.
    const leg = ragdoll.bodyOf('upperLeg.L')?.position;
    expect(leg?.x).toBeCloseTo(2);
    expect(leg?.y).toBeCloseTo(0.95);
    expect(leg?.z).toBeCloseTo(-0.1);
    expect(ragdoll.bodyOf('root')).toBeUndefined();
  });

  it('gives back the pose it started from', async () => {
    const w = await world();
    const sk = skeleton();
    const ragdoll = new Ragdoll(w, sk, { bones });
    const pose = sk.rest.clone();
    // The knee bent.
    pose.rotations.set([Math.sin(0.4), 0, 0, Math.cos(0.4)], 5 * 4);
    ragdoll.activate(pose, matrix);
    const out = ragdoll.readPose(sk.rest.clone());
    for (let i = 0; i < pose.translations.length; i++) {
      expect(out.translations[i]).toBeCloseTo(pose.translations[i], 4);
    }
    for (let i = 0; i < pose.rotations.length; i++) {
      expect(out.rotations[i]).toBeCloseTo(pose.rotations[i], 4);
    }
  });

  it('falls to the ground, its joints holding', async () => {
    const w = await world();
    const sk = skeleton();
    const ragdoll = new Ragdoll(w, sk, { bones });
    ragdoll.activate(sk.rest, matrix, { z: -2 });
    for (let i = 0; i < 180; i++) w.step(1 / 60);
    const hips = ragdoll.bodyOf('hips')?.position;
    expect(hips?.y).toBeLessThan(0.4);
    expect(hips?.y).toBeGreaterThan(0);
    // Pushed along −z of the world.
    expect(hips?.z).toBeLessThan(-0.2);
    const pose = ragdoll.readPose(sk.rest.clone());
    // The bones keep their lengths: the joints hold.
    const [x, y, z] = pose.translation(5);
    expect(Math.hypot(x, y, z)).toBeCloseTo(0.45, 1);
  });

  it('leaves the world when deactivated', async () => {
    const w = await world();
    const sk = skeleton();
    const ragdoll = new Ragdoll(w, sk, { bones });
    ragdoll.activate(sk.rest, matrix);
    ragdoll.deactivate();
    expect(ragdoll.active).toBe(false);
    expect([...w.bodies].length).toBe(1);
    expect([...w.joints].length).toBe(0);
    // Inactive: the pose of the activation.
    expect(ragdoll.readPose(sk.rest.clone()).translation(1)).toEqual([0, 1, 0]);
  });

  it('refuses unknown joints and bones twice on a joint', async () => {
    const w = await world();
    expect(
      () =>
        new Ragdoll(w, skeleton(), { bones: [{ joint: 'tail', radius: 1 }] }),
    ).toThrow(/no joint "tail"/);
    expect(
      () =>
        new Ragdoll(w, skeleton(), {
          bones: [
            { joint: 'hips', radius: 1 },
            { joint: 'hips', radius: 1 },
          ],
        }),
    ).toThrow(/two bones/);
  });
});
