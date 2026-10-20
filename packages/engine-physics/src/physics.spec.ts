import { describe, expect, it } from 'vitest';
import type { IQuat, IVec3 } from '@fdw/engine-backend';
import { TransformLayout } from '@fdw/engine-core';
import { Camera, Renderer } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import { ResourceStore } from '@fdw/engine-resources';
import { Scene, Scheduler } from '@fdw/engine-scene';
import {
  captureScene,
  instantiateScene,
  parseFdwScene,
  sceneCodecs,
  writeFdwScene,
} from '@fdw/engine-scene-io';
import type {
  BodyDesc,
  CharacterDesc,
  ColliderDesc,
  PhysicsCharacter,
  PhysicsBody,
  PhysicsCollider,
  PhysicsEngine,
  PhysicsWorld,
} from './api';
import { DebugLines, drawShape, drawWorld } from './debug/DebugLines';
import { PhysicsDebugView } from './debug/PhysicsDebugView';
import { mixPoses, poseOfMatrix } from './math';
import { physicsCodec } from './codec';
import { ScenePhysics } from './ScenePhysics';
import { Shapes } from './shapes';

// A world without collisions: the bodies fall and move, nothing more. What
// the binding to the scene needs, and the proof that the API does not ask
// for Rapier.
class FakeBody implements PhysicsBody {
  colliders: PhysicsCollider[] = [];
  userData: unknown;
  position: IVec3;
  rotation: IQuat;
  linearVelocity: IVec3;
  angularVelocity = { x: 0, y: 0, z: 0 };
  next?: IVec3;
  mass = 1;
  sleeping = false;

  constructor(
    readonly world: FakeWorld,
    readonly type: BodyDesc['type'],
    desc: BodyDesc,
  ) {
    this.position = { x: 0, y: 0, z: 0, ...desc.position };
    this.rotation = desc.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    this.linearVelocity = { x: 0, y: 0, z: 0, ...desc.linearVelocity };
    for (const collider of desc.colliders ?? []) {
      this.addCollider(collider);
    }
  }

  readPose(out: Float32Array | number[], offset = 0): void {
    const { position: p, rotation: r } = this;
    out[offset] = p.x;
    out[offset + 1] = p.y;
    out[offset + 2] = p.z;
    out[offset + 3] = r.x;
    out[offset + 4] = r.y;
    out[offset + 5] = r.z;
    out[offset + 6] = r.w;
  }

  setPose(position?: Partial<IVec3>, rotation?: IQuat): void {
    this.position = { ...this.position, ...position };
    this.rotation = rotation ?? this.rotation;
  }

  moveTo(position?: Partial<IVec3>, rotation?: IQuat): void {
    this.next = { ...this.position, ...position };
    this.rotation = rotation ?? this.rotation;
  }

  applyImpulse(impulse: IVec3): void {
    this.linearVelocity = {
      x: this.linearVelocity.x + impulse.x,
      y: this.linearVelocity.y + impulse.y,
      z: this.linearVelocity.z + impulse.z,
    };
  }

  applyForce(): void {
    // Nothing in the fake.
  }
  applyTorqueImpulse(): void {
    // Nothing in the fake.
  }
  wakeUp(): void {
    // Nothing in the fake.
  }

  addCollider(desc: ColliderDesc): PhysicsCollider {
    const collider: PhysicsCollider = {
      body: this,
      shape: desc.shape,
      sensor: desc.sensor ?? false,
      friction: 0.5,
      restitution: 0,
      userData: undefined,
      readPose: (out, offset) => this.readPose(out, offset),
    };
    this.colliders.push(collider);
    return collider;
  }

  removeCollider(): void {
    // Nothing in the fake.
  }
}

class FakeWorld implements PhysicsWorld {
  gravity = { x: 0, y: -10, z: 0 };
  readonly bodies = new Set<FakeBody>();
  readonly joints = [];
  readonly events = [];
  readonly removed: PhysicsBody[] = [];

  constructor(readonly engine: PhysicsEngine) {}

  createBody(desc: BodyDesc): FakeBody {
    const body = new FakeBody(this, desc.type, desc);
    this.bodies.add(body);
    return body;
  }

  removeBody(body: PhysicsBody): void {
    this.bodies.delete(body as FakeBody);
    this.removed.push(body);
  }

  step(dt: number): void {
    for (const body of this.bodies) {
      if (body.type === 'dynamic') {
        body.linearVelocity.y += this.gravity.y * dt;
        body.position = {
          x: body.position.x + body.linearVelocity.x * dt,
          y: body.position.y + body.linearVelocity.y * dt,
          z: body.position.z + body.linearVelocity.z * dt,
        };
      } else if (body.type === 'kinematic' && body.next) {
        body.position = body.next;
        body.next = undefined;
      }
    }
  }

  contacts(visit: Parameters<PhysicsWorld['contacts']>[0]): void {
    const [a] = [...this.bodies].flatMap((body) => body.colliders);
    if (a) {
      visit({
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        depth: 0,
        a,
        b: a,
      });
    }
  }

  createJoint(): never {
    throw new Error('Not in the fake');
  }
  removeJoint(): void {
    // Nothing in the fake.
  }
  createCharacter(desc: CharacterDesc): PhysicsCharacter {
    const body = this.createBody({
      type: 'kinematic',
      position: desc.position,
      colliders: [{ shape: desc.shape }],
    });
    return {
      body,
      grounded: false,
      move: () => ({
        movement: { x: 0, y: 0, z: 0 },
        grounded: false,
        collisions: [],
      }),
    };
  }
  removeCharacter(): void {
    // Nothing in the fake.
  }
  raycast(): undefined {
    return undefined;
  }
  raycastAll(): void {
    // Nothing in the fake.
  }
  shapeCast(): undefined {
    return undefined;
  }
  overlap(): void {
    // Nothing in the fake.
  }
  destroy(): void {
    // Nothing in the fake.
  }
}

const fakeEngine: PhysicsEngine = {
  name: 'fake',
  createWorld: () => new FakeWorld(fakeEngine),
};

const close = (values: ArrayLike<number>, digits = 4) =>
  Array.from(values, (v) => +v.toFixed(digits) + 0);

describe('math', () => {
  it('reads the pose of a scaled and turned matrix', () => {
    const scene = new Scene();
    const node = scene.root.add({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      scale: { x: 2, y: 3, z: 4 },
    });
    const pose = new Float32Array(7);
    poseOfMatrix(node.worldMatrix, pose);
    expect(close(pose)).toEqual([1, 2, 3, 0, 0.7071, 0, 0.7071]);
    // Half a turn around x: the other branches of the conversion.
    for (const rotation of [
      { x: 1, y: 0, z: 0, w: 0 },
      { x: 0, y: 1, z: 0, w: 0 },
      { x: 0, y: 0, z: 1, w: 0 },
    ]) {
      poseOfMatrix(scene.root.add({ rotation }).worldMatrix, pose);
      expect(close(pose.subarray(3))).toEqual([
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
      ]);
    }
  });

  it('mixes poses along the shortest path', () => {
    const poses = new Float32Array([
      0, 0, 0, 0, 0, 0, 1,
      // The same rotation as identity, negated: no turn between them.
      2, 4, 6, 0, 0, 0, -1,
    ]);
    const out = new Float32Array(7);
    mixPoses(poses, 0, 7, 0.5, out, 0, 3);
    expect(close(out)).toEqual([1, 2, 3, 0, 0, 0, 1]);
  });
});

describe('DebugLines', () => {
  it('draws every shape at its pose, and grows', () => {
    const lines = new DebugLines();
    const at = [10, 0, 0, 0, 0, 0, 1];
    const count = (shape: Parameters<typeof drawShape>[1]) => {
      lines.clear();
      drawShape(lines, shape, at, [1, 1, 1]);
      return lines.count / 2;
    };
    expect(count(Shapes.box(1))).toBe(12);
    expect(count(Shapes.sphere(1))).toBe(48);
    expect(count(Shapes.cylinder(1, 0.5))).toBe(36);
    expect(count(Shapes.capsule(1, 0.5))).toBe(36 + 64);
    expect(count(Shapes.convex([0, 0, 0, 1, 0, 0, 0, 1, 0]))).toBe(9);
    expect(count(Shapes.convex([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBe(
      3,
    );
    expect(count(Shapes.mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBe(3);
    // 3 × 2 samples: 2 × 2 along x, 3 along z.
    expect(
      count(Shapes.heightfield(2, 3, [0, 0, 0, 1, 1, 1], { x: 2, y: 1, z: 2 })),
    ).toBe(7);
    // The box, around x = 10.
    lines.clear();
    drawShape(lines, Shapes.box(1), at, [1, 0, 0]);
    const xs = [];
    for (let i = 0; i < lines.count; i++) {
      xs.push(lines.positions[i * 3]);
    }
    expect(Math.min(...xs)).toBe(9);
    expect(Math.max(...xs)).toBe(11);
    expect([...lines.colors.subarray(0, 4)]).toEqual([1, 0, 0, 1]);

    lines.clear();
    for (let i = 0; i < 2000; i++) {
      lines.line(0, 0, 0, i, 0, 0, [1, 1, 1]);
    }
    expect(lines.count).toBe(4000);
    expect(lines.positions[3999 * 3]).toBe(1999);
  });

  it('colors the bodies by state, and draws the contacts', () => {
    const world = fakeEngine.createWorld();
    world.createBody({
      type: 'static',
      colliders: [{ shape: Shapes.box(1) }],
    });
    const lines = new DebugLines();
    drawWorld(world, lines, { colors: { static: [0, 1, 0] } });
    // The box, then the contact: a cross and its normal.
    expect(lines.count).toBe(2 * (12 + 4));
    expect([...lines.colors.subarray(0, 3)]).toEqual([0, 1, 0]);
    lines.clear();
    drawWorld(world, lines, { contacts: false });
    expect(lines.count).toBe(24);
  });
});

describe('ScenePhysics', () => {
  it('moves the nodes of the dynamic bodies, drawn between two steps', () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const node = scene.root.add({
      position: { y: 10 },
      scale: { x: 2, y: 2, z: 2 },
    });
    const body = physics.add(node, {
      type: 'dynamic',
      colliders: [{ shape: Shapes.sphere(1) }],
    });
    expect(body.position.y).toBe(10);
    expect(physics.bodyOf(node)).toBe(body);
    expect(physics.entityOf(body)).toBe(node.entity);
    expect(physics.nodeOf(body.colliders[0])?.entity).toBe(node.entity);

    const scheduler = new Scheduler({ step: 0.1 });
    physics.install(scheduler);
    expect(scheduler.systems('fixed').map((s) => s.name)).toEqual(['physics']);
    expect(scheduler.systems('update').map((s) => s.name)).toEqual([
      'physics:sync',
    ]);
    // Two steps (10 → 9.9 → 9.7), then half a step: between the last two.
    scheduler.update(0.25);
    expect(body.position.y).toBeCloseTo(9.7);
    expect(node.transform.position.y).toBeCloseTo(9.8);
    // Its scale is the node's.
    expect(node.transform.scale.x).toBe(2);
    physics.interpolate = false;
    physics.sync(0.5);
    expect(node.transform.position.y).toBeCloseTo(9.7);
  });

  it('stops writing the nodes at rest', () => {
    const scene = new Scene();
    const world = fakeEngine.createWorld();
    const physics = new ScenePhysics(scene, world);
    const node = scene.root.add();
    const body = physics.add(node, { type: 'dynamic', gravityScale: 0 });
    world.gravity = { x: 0, y: 0, z: 0 };
    physics.step(0.1);
    physics.sync(1);
    // Written by hand: kept, the body did not move.
    node.transform.position = { x: 5, y: 0, z: 0 };
    physics.step(0.1);
    physics.sync(1);
    expect(node.transform.position.x).toBe(5);
    body.applyImpulse({ x: 1, y: 0, z: 0 });
    physics.step(0.1);
    physics.sync(1);
    expect(node.transform.position.x).toBeCloseTo(0.1);
  });

  it('moves the kinematic bodies to their nodes', () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const parent = scene.root.add({ position: { x: 10 } });
    const platform = parent.add({ position: { y: 1 } });
    const body = physics.add(platform, { type: 'kinematic' });
    expect(body.position).toEqual({ x: 10, y: 1, z: 0 });
    platform.transform.position = { x: 0, y: 2, z: 0 };
    physics.step(0.1);
    expect(body.position).toEqual({ x: 10, y: 2, z: 0 });
    // The static bodies: where their node is, under any parent.
    const wall = physics.add(parent.add({ position: { z: 3 } }), {
      type: 'static',
    });
    expect(wall.position).toEqual({ x: 10, y: 0, z: 3 });
  });

  it('refuses a node following its body away from the root', () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const child = scene.root.add().add();
    expect(() => physics.add(child, { type: 'dynamic' })).toThrow(
      'under the root',
    );
  });

  it('removes the body with its node, or alone', () => {
    const scene = new Scene();
    const world = fakeEngine.createWorld() as FakeWorld;
    const physics = new ScenePhysics(scene, world);
    const a = scene.root.add();
    const b = scene.root.add();
    const bodyA = physics.add(a, { type: 'dynamic' });
    const bodyB = physics.add(b, { type: 'dynamic' });
    a.remove();
    expect(world.removed).toEqual([bodyA]);
    physics.remove(b);
    expect(world.removed).toEqual([bodyA, bodyB]);
    expect(b.alive).toBe(true);
    expect(physics.bodyOf(b)).toBeUndefined();
    expect(physics.entityOf(bodyB)).toBeUndefined();
    // A new body replaces the old one.
    const c = scene.root.add();
    const first = physics.add(c, { type: 'dynamic' });
    physics.add(c, { type: 'static' });
    expect(world.removed).toContain(first);
    physics.destroy();
    expect(world.bodies.size).toBe(0);
  });

  it('teleports without drawing the way between', () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const node = scene.root.add({ position: { y: 5 } });
    const body = physics.add(node, { type: 'dynamic' });
    physics.step(0.1);
    physics.teleport(node, { x: 3, y: 1, z: 0 });
    const position = () => {
      const { x, y, z } = node.transform.position;
      return [x, y, z];
    };
    expect(position()).toEqual([3, 1, 0]);
    expect(body.linearVelocity).toEqual({ x: 0, y: 0, z: 0 });
    physics.sync(0.5);
    expect(position()).toEqual([3, 1, 0]);
    expect(() => physics.teleport(scene.root.add(), {})).toThrow('no body');
  });

  it('writes the pose in the transform pool', () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const node = scene.root.add();
    const body = physics.add(node, { type: 'dynamic' });
    body.setPose({ x: 1 }, { x: 0, y: 1, z: 0, w: 0 });
    physics.step(0);
    physics.sync(1);
    const { stride, rotation } = TransformLayout;
    const o = node.entity * stride + rotation;
    expect(close(scene.transforms.data.subarray(o, o + 4))).toEqual([
      0, 1, 0, 0,
    ]);
  });
});

describe('physicsCodec', () => {
  it('saves the bodies of the nodes, made again when loaded', async () => {
    const scene = new Scene();
    const physics = new ScenePhysics(scene, fakeEngine.createWorld());
    const ground = scene.root.add({ name: 'ground' });
    const heights = new Float32Array([0, 1, 2, 3]);
    physics.add(ground, {
      type: 'static',
      colliders: [
        {
          shape: Shapes.heightfield(2, 2, heights, { x: 10, y: 4, z: 10 }),
          material: { friction: 0.8 },
          userData: { app: 'object' },
        },
      ],
    });
    const crate = scene.root.add({ name: 'crate', position: { y: 3 } });
    physics.add(crate, {
      type: 'dynamic',
      ccd: true,
      colliders: [{ shape: Shapes.box(0.5), density: 2 }],
    });
    const hero = scene.root.add({ name: 'hero', position: { x: 2 } });
    physics.addCharacter(hero, {
      shape: Shapes.capsule(0.6, 0.3),
      stepHeight: 0.2,
    });
    const codecs = [...sceneCodecs, physicsCodec(physics)];
    const warnings: string[] = [];
    const data = captureScene(scene, {
      codecs,
      warn: (m) => void warnings.push(m),
    });
    expect(warnings).toEqual([expect.stringMatching(/userData is not saved/)]);
    const byName = (name: string) =>
      data.nodes.find((n) => n.name === name)!.components!['physics body'];
    expect(byName('crate')).toEqual({
      version: 1,
      data: {
        body: {
          type: 'dynamic',
          ccd: true,
          colliders: [{ shape: Shapes.box(0.5), density: 2 }],
        },
      },
    });
    expect(byName('hero').data).toEqual({
      character: { shape: Shapes.capsule(0.6, 0.3), stepHeight: 0.2 },
    });
    // Through the format: the heights in the binary.
    const files = await writeFdwScene(data, 'level.scene.json');
    const read = parseFdwScene(
      new TextDecoder().decode(files[0].bytes),
      files[1].bytes,
    );
    const other = new Scene();
    const world = fakeEngine.createWorld();
    const otherPhysics = new ScenePhysics(other, world);
    await instantiateScene(read, other, {
      store: new ResourceStore(),
      codecs: [...sceneCodecs, physicsCodec(otherPhysics)],
      wrap: false,
    });
    const crateBody = otherPhysics.bodyOf(other.find('crate')!)!;
    expect(crateBody.type).toBe('dynamic');
    expect(crateBody.position.y).toBe(3);
    expect(otherPhysics.characterOf(other.find('hero')!)).toBeDefined();
    const shape = otherPhysics.bodyOf(other.find('ground')!)!.colliders[0]
      .shape;
    expect(shape.type === 'heightfield' && [...shape.heights]).toEqual([
      0, 1, 2, 3,
    ]);
  });
});

describe('PhysicsDebugView', () => {
  it('draws the world and the rays in lines, rendered', () => {
    const scene = new Scene();
    const world = fakeEngine.createWorld();
    world.createBody({
      type: 'dynamic',
      colliders: [{ shape: Shapes.box(1) }],
    });
    const view = new PhysicsDebugView(scene, world, { rayLife: 0.5 });
    view.ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 10);
    view.update(0.1);
    // The box, the contact, the ray.
    expect(view.lines.count).toBe(2 * (12 + 4 + 1));
    expect(view.node.visible).toBe(true);
    view.update(0.5);
    expect(view.lines.count).toBe(2 * (12 + 4));

    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 60,
        aspect: 1,
        near: 0.1,
        far: 100,
      },
    });
    scene.root.add({ position: { z: 10 } }).setCamera(camera);
    renderer.render({ source: scene, camera, surface });
    const pipelines = log.pipelines.map(
      (descriptor) => descriptor.primitive.topology,
    );
    expect(pipelines).toContain('line-list');

    view.enabled = false;
    expect(view.node.visible).toBe(false);
    view.update(0.1);
    view.enabled = true;
    view.destroy();
    expect(view.node.alive).toBe(false);
  });
});
