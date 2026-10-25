import { RenderGraph, Renderer } from '@fdw/engine-core';
import { fakeBackend } from '@fdw/engine-core/testing';
import type { PhysicsBody } from '@fdw/engine-physics';
import { describe, expect, it } from 'vitest';
import { BodyStride, FluidBodies, MaxBodies, packBodies } from './bodies';
import { ParticleFluid } from './particles/ParticleFluid';
import { ShallowWater } from './shallow/ShallowWater';
import { WaterSurface } from './shallow/WaterSurface';
import { SmokeGrid } from './smoke/SmokeGrid';
import { SmokeRenderer } from './smoke/SmokeRenderer';

// A body of the physics without an engine: its colliders, its pose.
function body(colliders: PhysicsBody['colliders'][number]['shape'][]) {
  const world = { bodies: [] as PhysicsBody[] };
  const fake = {
    world,
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0.5, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 1, z: 0 },
    colliders: colliders.map((shape, n) => ({
      shape,
      sensor: false,
      // Each collider a meter above the last.
      readPose: (out: Float32Array) => out.set([1, 2 + n, 3, 0, 0, 0, 1]),
    })),
  } as unknown as PhysicsBody;
  world.bodies.push(fake);
  return { fake, world };
}

describe('fluid bodies', () => {
  it('writes the shapes of the bodies where their colliders are', () => {
    const { backend, log } = fakeBackend();
    const bodies = new FluidBodies(backend);
    const { fake, world } = body([
      { type: 'sphere', radius: 0.5 },
      { type: 'box', halfExtents: { x: 1, y: 0.2, z: 0.3 } },
      {
        type: 'convex',
        points: new Float32Array([-1, 0, 0, 2, 0.5, 0, 0, -1, 1]),
      },
    ]);
    bodies.add(fake).update();
    expect(bodies.count).toBe(3);
    const data = new Float32Array(log.buffers[0].data);
    // The sphere: center, kind 0, radius; the box: kind 1, half extents.
    expect([...data.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
    expect(data[8]).toBe(0.5);
    expect([...data.subarray(BodyStride * 4, BodyStride * 4 + 4)]).toEqual([
      1, 3, 3, 1,
    ]);
    // The bounds of the convex hull, around its collider.
    expect([...data.subarray(BodyStride * 8 + 8, BodyStride * 8 + 11)]).toEqual(
      [2, 1, 1],
    );
    // The velocity and the center of mass of the body, for each shape.
    expect(data[BodyStride * 4 + 12]).toBe(0.5);
    expect([
      ...data.subarray(BodyStride * 4 + 20, BodyStride * 4 + 23),
    ]).toEqual([1, 2, 3]);
    // Removed from its world: forgotten.
    world.bodies.length = 0;
    expect(bodies.update().count).toBe(0);
  });

  it('takes shapes moved by the application, up to its limit', () => {
    const { backend } = fakeBackend();
    const bodies = new FluidBodies(backend);
    const shape = packBodies([]);
    expect(shape).toHaveLength(BodyStride * 4);
    for (let i = 0; i < MaxBodies + 1; i++) {
      bodies.addShape({
        shape: { type: 'sphere', radius: 1 },
        position: { x: i, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        center: { x: i, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      });
    }
    expect(() => bodies.update()).toThrow(/64 shapes at most/);
    expect(bodies.clearShapes().update().count).toBe(0);
    expect(() =>
      bodies.add(
        body([
          {
            type: 'mesh',
            vertices: new Float32Array(),
            indices: new Uint32Array(),
          },
        ]).fake,
      ),
    ).toThrow(/no shape/);
  });
});

describe('fluids on a backend', () => {
  it('runs the shallow water in its steps, read back for the physics', async () => {
    const { backend, log } = fakeBackend();
    const water = new ShallowWater(backend, {
      resolution: [16, 8],
      cell: 0.5,
      ground: (x) => x * 0.2,
      level: 0.5,
      maxDepth: 1,
    });
    // At rest, the water up to its level where the ground is lower.
    expect(water.heightAt(-2, 0)).toBeCloseTo(0.5, 5);
    expect(water.depthAt(3.8, 0)).toBe(0);
    const before = log.dispatches.length;
    water.update(0.1);
    // Two dispatches a step, the steps short enough, then the surface.
    const steps = Math.ceil(0.1 / water.maxStep);
    expect(log.dispatches.length - before).toBe(steps * 2 + 1);
    const surface = new WaterSurface(water, {
      environment: { texture: {} as never, sampler: {} as never, levels: 1 },
    });
    expect(surface.material.renderState.alphaMode).toBe('mask');
    expect(surface.mesh.description.vertexCount).toBe(17 * 9);
    water.destroy();
  });

  it('runs the smoke, and draws it over a scene', () => {
    const { backend, log } = fakeBackend({
      renderableFormats: ['rgba16float'],
    });
    const smoke = new SmokeGrid(backend, {
      resolution: [8, 8, 8],
      iterations: 5,
    });
    smoke.addEmitter({
      x: 0,
      y: 0.2,
      z: 0,
      radius: 0.2,
      density: 1,
      temperature: 2,
    });
    smoke.update(1 / 60);
    // Obstacles, two advections, vorticity, confinement, divergence, the
    // pressure, the projection, the shade.
    expect(log.dispatches).toHaveLength(8 + 5);
    const renderer = new Renderer(backend);
    const smokeRenderer = new SmokeRenderer(renderer);
    const graph = new RenderGraph({ size: { width: 64, height: 64 } });
    const color = graph.createTexture('color', { format: 'rgba16float' });
    const depth = graph.createTexture('depth', { format: 'rgba16float' });
    const out = smokeRenderer.addPass(graph, { smoke, color, depth });
    expect(out).not.toBe(color);
    expect(smokeRenderer.materialOf(smoke).getValue('smokeShade')).toBe(
      smoke.shade,
    );
    smoke.destroy();
  });

  it('runs the particles: a sort, the constraints, the columns', () => {
    const { backend, log } = fakeBackend();
    const liquid = new ParticleFluid(backend, {
      count: 256,
      radius: 0.05,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      substeps: 1,
      iterations: 2,
    });
    expect(liquid.addBlock([0, 0, 0], [0.4, 0.4, 0.4])).toBe(64);
    // Beyond the capacity: left out.
    expect(liquid.add(new Float32Array(400 * 4))).toBe(192);
    expect(liquid.active).toBe(256);
    liquid.update(1 / 60);
    // Predict, keys, 36 stages of the sort, clear, ranges, reorder, 2 × 2
    // constraints, velocities, viscosity, columns.
    expect(log.dispatches).toHaveLength(2 + 36 + 3 + 4 + 2 + 1);
    // Nothing read back yet: dry everywhere.
    expect(liquid.heightAt(0.5, 0.5)).toBe(0);
    liquid.clear();
    expect(liquid.active).toBe(0);
    liquid.destroy();
  });

  it('needs a backend with compute', () => {
    const { backend } = fakeBackend({ compute: false });
    expect(() => new ShallowWater(backend, { resolution: [4, 4] })).toThrow(
      /compute/,
    );
    expect(() => new SmokeGrid(backend, { resolution: [4, 4, 4] })).toThrow(
      /compute/,
    );
    expect(
      () =>
        new ParticleFluid(backend, {
          bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        }),
    ).toThrow(/compute/);
  });
});
