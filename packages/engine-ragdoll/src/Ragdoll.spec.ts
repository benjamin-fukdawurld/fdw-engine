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

  it('keeps a limb within its cone', async () => {
    const swingOf = async (cone?: number) => {
      const w = await world();
      const sk = skeleton();
      const ragdoll = new Ragdoll(w, sk, {
        bones: [
          { joint: 'hips', to: 'spine', radius: 0.12 },
          {
            joint: 'upperLeg.L',
            to: 'lowerLeg.L',
            radius: 0.07,
            ...(cone !== undefined ? { cone, twist: [-0.2, 0.2] } : {}),
          },
        ],
      });
      ragdoll.activate(sk.rest, matrix);
      const hips = ragdoll.bodyOf('hips');
      const leg = ragdoll.bodyOf('upperLeg.L');
      if (!hips || !leg) throw new Error('no bodies');
      // Kicked forward and sideways.
      leg.applyImpulse({ x: 1.5, y: 0, z: 1.5 }, leg.position);
      let most = 0;
      for (let i = 0; i < 60; i++) {
        w.step(1 / 60);
        // The leg in the frame of the hips: down at the activation.
        const a = hips.rotation;
        const b = leg.rotation;
        const r = {
          x: a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y,
          y: a.w * b.y + a.x * b.z - a.y * b.w - a.z * b.x,
          z: a.w * b.z - a.x * b.y + a.y * b.x - a.z * b.w,
          w: a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z,
        };
        // (0, -1, 0) turned by r: its y.
        const down = -(1 - 2 * (r.x * r.x + r.z * r.z));
        most = Math.max(most, Math.acos(Math.min(1, -down)));
      }
      return most;
    };
    expect(await swingOf()).toBeGreaterThan(0.8);
    const limited = await swingOf(0.4);
    expect(limited).toBeLessThan(0.5);
  });

  it('hangs a bone on another joint than its ancestor', async () => {
    const w = await world();
    // A foot moved by inverse kinematics: under the root, not the leg.
    const sk = new Skeleton([
      { name: 'root' },
      { name: 'hips', parent: 0, translation: [0, 1, 0] },
      { name: 'upperLeg', parent: 1, translation: [0.1, -0.05, 0] },
      { name: 'lowerLeg', parent: 2, translation: [0, -0.45, 0] },
      { name: 'foot', parent: 0, translation: [0.1, 0.05, 0] },
    ]);
    const ragdoll = new Ragdoll(w, sk, {
      bones: [
        { joint: 'hips', radius: 0.12 },
        { joint: 'upperLeg', to: 'lowerLeg', radius: 0.07 },
        { joint: 'lowerLeg', to: 'foot', radius: 0.06 },
        { joint: 'foot', radius: 0.05, attach: 'lowerLeg' },
      ],
    });
    ragdoll.activate(sk.rest, matrix, { x: 1 });
    expect([...w.joints]).toHaveLength(3);
    for (let i = 0; i < 120; i++) w.step(1 / 60);
    // Still at the end of the lower leg.
    const foot = ragdoll.bodyOf('foot')?.position;
    const knee = ragdoll.bodyOf('lowerLeg')?.position;
    if (!foot || !knee) throw new Error('no bodies');
    expect(
      Math.hypot(foot.x - knee.x, foot.y - knee.y, foot.z - knee.z),
    ).toBeCloseTo(0.45, 1);
    expect(
      () =>
        new Ragdoll(w, sk, {
          bones: [{ joint: 'foot', radius: 0.05, attach: 'toe' }],
        }),
    ).toThrow(/no joint "toe"/);
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
