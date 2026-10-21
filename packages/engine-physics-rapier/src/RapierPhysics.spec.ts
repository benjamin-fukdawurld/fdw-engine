import { beforeAll, describe, expect, it } from 'vitest';
import type { PhysicsWorld } from '@fdw/engine-physics';
import { Shapes } from '@fdw/engine-physics';
import { createRapierPhysics, RapierPhysics } from './RapierPhysics';

let engine: RapierPhysics;
beforeAll(async () => {
  engine = await createRapierPhysics();
});

const down = { x: 0, y: -1, z: 0 };
const identity = { x: 0, y: 0, z: 0, w: 1 };
// A quarter turn around y.
const quarter = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

function run(world: PhysicsWorld, seconds: number, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) {
    world.step(step);
  }
}

function withGround(): PhysicsWorld {
  const world = engine.createWorld();
  world.createBody({
    type: 'static',
    position: { y: -0.5 },
    colliders: [{ shape: Shapes.box(20, 0.5, 20) }],
  });
  return world;
}

describe('RapierPhysics', () => {
  it('loads once, and names itself', async () => {
    expect(engine.name).toBe('rapier');
    expect(await createRapierPhysics()).toBeInstanceOf(RapierPhysics);
    expect(engine.version).toMatch(/^\d+\.\d+/);
  });

  it('drops a box on the ground, where it sleeps', () => {
    const world = withGround();
    const box = world.createBody({
      type: 'dynamic',
      position: { y: 3 },
      colliders: [{ shape: Shapes.box(0.5) }],
    });
    expect(box.type).toBe('dynamic');
    // Free fall: y = 3 - g t² / 2, within the error of the integration.
    for (let i = 0; i < 30; i++) {
      world.step(1 / 60);
    }
    expect(Math.abs(box.position.y - (3 - (9.81 * 0.25) / 2))).toBeLessThan(
      0.1,
    );
    run(world, 4);
    expect(box.position.y).toBeCloseTo(0.5, 1);
    expect(box.sleeping).toBe(true);
    // 1 m³ at 1 kg/m³.
    expect(box.mass).toBeCloseTo(1);
    world.destroy();
  });

  it('reads poses without allocating, and teleports', () => {
    const world = engine.createWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const body = world.createBody({
      type: 'dynamic',
      position: { x: 1, y: 2, z: 3 },
      rotation: quarter,
      colliders: [{ shape: Shapes.sphere(0.5), position: { x: 1 } }],
    });
    const pose = new Float32Array(9);
    body.readPose(pose, 2);
    expect([...pose.subarray(2)].map((v) => +v.toFixed(4))).toEqual([
      1, 2, 3, 0, 0.7071, 0, 0.7071,
    ]);
    // The collider: one meter along x of the body, turned to -z.
    body.colliders[0].readPose(pose);
    expect(pose[0]).toBeCloseTo(1);
    expect(pose[2]).toBeCloseTo(2);
    body.setPose({ y: 5 }, identity);
    expect(body.position).toEqual({ x: 1, y: 5, z: 3 });
    world.destroy();
  });

  it('applies impulses, forces for one step, and gravity scales', () => {
    const world = engine.createWorld({ gravity: { x: 0, y: 0, z: 0 } });
    const body = world.createBody({
      type: 'dynamic',
      colliders: [{ shape: Shapes.box(0.5), density: 2 }],
    });
    body.applyImpulse({ x: 4, y: 0, z: 0 });
    expect(body.linearVelocity.x).toBeCloseTo(2);
    body.applyForce({ x: 0, y: 120, z: 0 });
    world.step(1 / 60);
    expect(body.linearVelocity.y).toBeCloseTo(1);
    // Reset after the step.
    world.step(1 / 60);
    expect(body.linearVelocity.y).toBeCloseTo(1);
    // Off center: it turns.
    body.applyImpulse({ x: 0, y: 1, z: 0 }, { x: 0.5, y: 0, z: 0 });
    expect(body.angularVelocity.z).toBeGreaterThan(0);
    // A force at a point turns it for one step: its torque is reset too.
    const spin = body.angularVelocity.z;
    const { x, y, z } = body.position;
    body.applyForce({ x: 0, y: 60, z: 0 }, { x: x + 0.5, y, z });
    world.step(1 / 60);
    const pushed = body.angularVelocity.z;
    expect(pushed).toBeGreaterThan(spin);
    world.step(1 / 60);
    expect(body.angularVelocity.z).toBeCloseTo(pushed, 3);

    const floating = world.createBody({
      type: 'dynamic',
      position: { x: 10 },
      gravityScale: 0,
      colliders: [{ shape: Shapes.sphere(0.5) }],
    });
    world.gravity = { x: 0, y: -10, z: 0 };
    run(world, 0.5);
    expect(floating.position.y).toBe(0);
    world.destroy();
  });

  it('moves the kinematic bodies, which push the dynamic ones', () => {
    const world = withGround();
    const pusher = world.createBody({
      type: 'kinematic',
      position: { x: -2, y: 0.5 },
      colliders: [{ shape: Shapes.box(0.5) }],
    });
    const box = world.createBody({
      type: 'dynamic',
      position: { x: 0, y: 0.5 },
      colliders: [{ shape: Shapes.box(0.5) }],
    });
    for (let i = 1; i <= 60; i++) {
      pusher.moveTo({ x: -2 + (3 * i) / 60 });
      world.step(1 / 60);
    }
    expect(pusher.position.x).toBeCloseTo(1);
    expect(box.position.x).toBeGreaterThan(1.9);
    world.destroy();
  });

  it('bounces by restitution, slides by friction', () => {
    const world = engine.createWorld();
    world.createBody({
      type: 'static',
      colliders: [
        {
          shape: Shapes.box(20, 0.5, 20),
          position: { y: -0.5 },
          material: { restitution: 1, friction: 0 },
        },
      ],
    });
    const ball = world.createBody({
      type: 'dynamic',
      position: { y: 2 },
      colliders: [
        {
          shape: Shapes.sphere(0.25),
          material: { restitution: 1, restitutionCombine: 'max' },
        },
      ],
    });
    let top = 0;
    let falling = false;
    for (let i = 0; i < 120; i++) {
      world.step(1 / 60);
      const v = ball.linearVelocity.y;
      falling ||= v < -1;
      if (falling && v > 0) {
        top = Math.max(top, ball.position.y);
      }
    }
    // Back up near where it fell from.
    expect(top).toBeGreaterThan(1.7);

    const slider = world.createBody({
      type: 'dynamic',
      position: { x: 5, y: 0.25 },
      linearVelocity: { x: 3 },
      colliders: [
        {
          shape: Shapes.box(0.25),
          material: { friction: 0, restitution: 0 },
        },
      ],
    });
    run(world, 1);
    // No friction: still sliding.
    expect(slider.linearVelocity.x).toBeCloseTo(3, 0);
    slider.colliders[0].friction = 1;
    slider.colliders[0].restitution = 0;
    expect(slider.colliders[0].friction).toBe(1);
    world.destroy();
  });

  it('casts rays: the first hit, all hits, the filters', () => {
    const world = withGround();
    const box = world.createBody({
      type: 'static',
      position: { y: 2 },
      colliders: [{ shape: Shapes.box(0.5), groups: 2 }],
    });
    const sensor = world.createBody({
      type: 'static',
      position: { y: 4 },
      colliders: [{ shape: Shapes.box(0.5), sensor: true }],
    });
    // The queries see the world of the last step.
    expect(world.raycast({ x: 0, y: 10, z: 0 }, down, 100)).toBeUndefined();
    world.step(1 / 60);

    const hit = world.raycast({ x: 0, y: 10, z: 0 }, down, 100);
    expect(hit?.body).toBe(box);
    expect(hit?.distance).toBeCloseTo(7.5);
    expect(hit?.point.y).toBeCloseTo(2.5);
    expect(hit?.normal.y).toBeCloseTo(1);
    // Only group 1: the ground.
    expect(
      world.raycast({ x: 0, y: 10, z: 0 }, down, 100, { mask: 1 })?.point.y,
    ).toBeCloseTo(0);
    expect(
      world.raycast({ x: 0, y: 10, z: 0 }, down, 100, { exclude: box })?.point
        .y,
    ).toBeCloseTo(0);
    expect(
      world.raycast({ x: 0, y: 10, z: 0 }, down, 100, { skip: ['static'] }),
    ).toBeUndefined();
    expect(
      world.raycast({ x: 0, y: 10, z: 0 }, down, 100, { sensors: true })?.body,
    ).toBe(sensor);
    expect(
      world.raycast({ x: 0, y: 10, z: 0 }, down, 100, {
        predicate: (collider) => collider.body !== box,
      })?.point.y,
    ).toBeCloseTo(0);
    expect(world.raycast({ x: 0, y: 10, z: 0 }, down, 5)).toBeUndefined();

    const hits: number[] = [];
    world.raycastAll({ x: 0, y: 10, z: 0 }, down, 100, (h) => {
      hits.push(Math.round(h.point.y * 10) / 10);
    });
    expect(hits.sort()).toEqual([0, 2.5]);
    let visits = 0;
    world.raycastAll({ x: 0, y: 10, z: 0 }, down, 100, () => {
      visits++;
      return false;
    });
    expect(visits).toBe(1);
    world.destroy();
  });

  it('casts shapes, and finds the overlaps', () => {
    const world = engine.createWorld();
    const box = world.createBody({
      type: 'static',
      position: { x: 5 },
      rotation: {
        x: 0,
        y: Math.sin(Math.PI / 8),
        z: 0,
        w: Math.cos(Math.PI / 8),
      },
      colliders: [{ shape: Shapes.box(1) }],
    });
    world.createBody({
      type: 'static',
      position: { x: -5 },
      colliders: [{ shape: Shapes.sphere(1) }],
    });
    world.step(1 / 60);
    const right = { x: 1, y: 0, z: 0 };
    const hit = world.shapeCast(
      Shapes.sphere(0.5),
      { x: 0, y: 0, z: 0 },
      identity,
      right,
      100,
    );
    expect(hit?.body).toBe(box);
    // The box turned by 45°: its edge toward the sphere, at 5 - √2.
    expect(hit?.point.x).toBeCloseTo(5 - Math.SQRT2, 2);
    expect(hit?.distance).toBeCloseTo(5 - Math.SQRT2 - 0.5, 2);
    expect(hit?.normal.x).toBeLessThan(-0.5);

    const found: unknown[] = [];
    world.overlap(
      Shapes.box(6, 0.5, 0.5),
      { x: 0, y: 0, z: 0 },
      identity,
      (c) => {
        found.push(c.body);
      },
    );
    expect(found).toHaveLength(2);
    found.length = 0;
    world.overlap(Shapes.sphere(1), { x: 0, y: 0, z: 0 }, identity, (c) => {
      found.push(c.body);
    });
    expect(found).toHaveLength(0);
    world.destroy();
  });

  it('reports the contacts and the sensors, entered and left', () => {
    const world = withGround();
    const trigger = world.createBody({
      type: 'static',
      position: { y: 2 },
      colliders: [{ shape: Shapes.box(1, 0.25, 1), sensor: true }],
    });
    const ball = world.createBody({
      type: 'dynamic',
      position: { y: 4 },
      colliders: [{ shape: Shapes.sphere(0.25), events: true }],
    });
    const seen: string[] = [];
    for (let i = 0; i < 120; i++) {
      world.step(1 / 60);
      for (const event of world.events) {
        const other = event.a.body === ball ? event.b.body : event.a.body;
        seen.push(
          `${event.type} ${other === trigger ? 'trigger' : 'ground'}${
            event.sensor ? ' (sensor)' : ''
          }`,
        );
      }
    }
    expect(seen).toEqual([
      'begin trigger (sensor)',
      'end trigger (sensor)',
      'begin ground',
    ]);
    // Resting: its contact points with the ground.
    const points: number[] = [];
    world.contacts(({ point, normal, a, b }) => {
      expect([a.body, b.body]).toContain(ball);
      expect(Math.abs(normal.y)).toBeCloseTo(1);
      points.push(point.y);
    });
    expect(points.length).toBeGreaterThan(0);
    expect(points[0]).toBeCloseTo(0, 1);
    world.destroy();
  });

  it('joins bodies: a ball joint chain, a hinge with limits and a motor', () => {
    const world = engine.createWorld();
    const anchor = world.createBody({ type: 'static', position: { y: 5 } });
    let previous = anchor;
    const links = [];
    // Links a meter long, joined end to end from (0.5, 5).
    for (let i = 1; i <= 3; i++) {
      const link = world.createBody({
        type: 'dynamic',
        position: { x: i, y: 5 },
        colliders: [{ shape: Shapes.sphere(0.2) }],
      });
      world.createJoint({
        type: 'ball',
        bodyA: previous,
        bodyB: link,
        anchorA: { x: 0.5 },
        anchorB: { x: -0.5 },
      });
      links.push(link);
      previous = link;
    }
    // Swinging below the anchor, the links a meter apart.
    let lowest = Infinity;
    for (let i = 0; i < 180; i++) {
      world.step(1 / 60);
      lowest = Math.min(lowest, links[2].position.y);
    }
    expect(lowest).toBeLessThan(3);
    const distance = (a: { x: number; y: number; z: number }, b: typeof a) =>
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(
      Math.abs(distance(links[0].position, links[1].position) - 1),
    ).toBeLessThan(0.1);
    expect([...world.joints]).toHaveLength(3);
    const anchors = new Float32Array(6);
    [...world.joints][1].readAnchors(anchors);
    expect(
      Math.hypot(anchors[0] - anchors[3], anchors[1] - anchors[4]),
    ).toBeLessThan(0.05);

    // Removing a body removes its joints.
    world.removeBody(links[1]);
    expect([...world.joints]).toHaveLength(1);

    const frame = world.createBody({ type: 'static' });
    const door = world.createBody({
      type: 'dynamic',
      position: { x: 0.5 },
      gravityScale: 0,
      colliders: [{ shape: Shapes.box(0.5, 1, 0.05) }],
    });
    const hinge = world.createJoint({
      type: 'hinge',
      bodyA: frame,
      bodyB: door,
      anchorB: { x: -0.5 },
      axis: { x: 0, y: 1, z: 0 },
      limits: [0, Math.PI / 4],
      motor: { velocity: 2, damping: 100 },
    });
    run(world, 2);
    // Turned around y up to its limit.
    const r = door.rotation;
    expect(2 * Math.atan2(r.y, r.w)).toBeCloseTo(Math.PI / 4, 1);
    hinge.setLimits(undefined);
    run(world, 0.5);
    expect(2 * Math.atan2(door.rotation.y, door.rotation.w)).toBeGreaterThan(
      Math.PI / 4 + 0.2,
    );
    expect(() =>
      world
        .createJoint({ type: 'ball', bodyA: frame, bodyB: door })
        .setMotor({ velocity: 1 }),
    ).toThrow('no limits nor motor');
    world.destroy();
  });

  it('welds bodies as they are with a fixed joint', () => {
    const world = engine.createWorld();
    const a = world.createBody({
      type: 'dynamic',
      position: { y: 5 },
      colliders: [{ shape: Shapes.box(0.5) }],
    });
    const b = world.createBody({
      type: 'dynamic',
      position: { x: 1, y: 5 },
      rotation: quarter,
      colliders: [{ shape: Shapes.box(0.5) }],
    });
    world.createJoint({ type: 'fixed', bodyA: a, bodyB: b, anchorA: { x: 1 } });
    run(world, 0.5);
    // Falling together, the quarter turn kept.
    expect(a.position.y).toBeLessThan(4);
    expect(b.position.y).toBeCloseTo(a.position.y, 2);
    expect(b.rotation.y).toBeCloseTo(Math.SQRT1_2, 2);
    world.destroy();
  });

  it('builds every shape', () => {
    const world = withGround();
    const shapes = [
      Shapes.sphere(0.5),
      Shapes.box(0.5, 0.25, 0.5),
      Shapes.capsule(0.5, 0.25),
      Shapes.cylinder(0.5, 0.25),
      Shapes.convex([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      Shapes.convex(
        [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
      ),
    ];
    const bodies = shapes.map((shape, i) =>
      world.createBody({
        type: 'dynamic',
        position: { x: i * 2 - 5, y: 2 },
        colliders: [{ shape }],
      }),
    );
    world.createBody({
      type: 'static',
      position: { z: 10 },
      colliders: [
        {
          shape: Shapes.mesh(
            [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5],
            [0, 2, 1, 0, 3, 2],
          ),
        },
      ],
    });
    run(world, 3);
    // Resting on the ground (the convex shapes have their origin on a
    // corner).
    for (const body of bodies) {
      expect(body.sleeping).toBe(true);
      expect(body.position.y).toBeGreaterThan(-0.05);
      expect(body.position.y).toBeLessThan(1);
    }
    expect(() =>
      world.createBody({
        type: 'static',
        colliders: [{ shape: Shapes.convex([0, 0, 0, 1, 1, 1]) }],
      }),
    ).toThrow('no hull');
    world.destroy();
  });

  it('lays heightfields out by rows along z, columns along x', () => {
    const world = engine.createWorld();
    // Rising along x only.
    world.createBody({
      type: 'static',
      colliders: [
        {
          shape: Shapes.heightfield(2, 3, [0, 1, 2, 0, 1, 2], {
            x: 4,
            y: 1,
            z: 2,
          }),
        },
      ],
    });
    world.step(1 / 60);
    const height = (x: number, z: number) =>
      world.raycast({ x, y: 10, z }, down, 100)?.point.y;
    expect(height(-2, 0.5)).toBeCloseTo(0);
    expect(height(-1, -0.5)).toBeCloseTo(0.5);
    expect(height(1, 0.5)).toBeCloseTo(1.5);
    expect(() =>
      Shapes.heightfield(2, 2, [0, 0, 0], { x: 1, y: 1, z: 1 }),
    ).toThrow('needs 4 heights');
    world.destroy();
  });

  it('moves a character: it slides along walls, climbs steps, falls', () => {
    const world = withGround();
    // A wall along x = 2, a step of 0.2 at z < -2.
    world.createBody({
      type: 'static',
      position: { x: 2.5, y: 1 },
      colliders: [{ shape: Shapes.box(0.5, 1, 10) }],
    });
    world.createBody({
      type: 'static',
      position: { y: 0.1, z: -6 },
      colliders: [{ shape: Shapes.box(1.5, 0.1, 4) }],
    });
    const character = world.createCharacter({
      shape: Shapes.capsule(0.5, 0.3),
      position: { y: 0.85 },
    });
    world.step(1 / 60);
    // Diagonally into the wall: slides along it.
    let collided = false;
    for (let i = 0; i < 60; i++) {
      const move = character.move({ x: 0.1, y: -0.05, z: 0.05 });
      collided ||= move.collisions.length > 0;
      world.step(1 / 60);
    }
    const p = character.body.position;
    expect(p.x).toBeCloseTo(2 - 0.3 - 0.02, 1);
    expect(p.z).toBeGreaterThan(2.5);
    expect(character.grounded).toBe(true);
    expect(collided).toBe(true);

    // Onto the step.
    character.body.setPose({ x: 0, y: 0.85, z: 0 });
    world.step(1 / 60);
    for (let i = 0; i < 60; i++) {
      character.move({ x: 0, y: -0.05, z: -0.1 });
      world.step(1 / 60);
    }
    expect(character.body.position.y).toBeCloseTo(1.05, 1);

    // Off the edge (snapped down a little, then falling).
    world.removeCharacter(character);
    expect([...world.bodies]).toHaveLength(3);
    world.destroy();
  });
});
