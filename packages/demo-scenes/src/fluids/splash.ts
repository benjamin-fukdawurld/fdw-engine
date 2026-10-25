import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import {
  FluidBodies,
  ParticleFluid,
  ParticleFluidRenderer,
  particleBlock,
} from '@fdw/engine-fluids';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { boxPoints, Buoyancy, createSky } from '@fdw/engine-ocean';
import { PhysicsEngine, ScenePhysics, Shapes } from '@fdw/engine-physics';
import type { Node } from '@fdw/engine-scene';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube } from '../geometry';
import { followAspect, SceneFactory } from '../scene';

/** The options of the tank. */
export interface SplashOptions {
  /** The particles it can hold: a power of two (16384). */
  readonly count?: number;
  /** The radius of a particle, in meters (0.02). */
  readonly radius?: number;
  /** Where the orbit camera starts. */
  readonly view?: { yaw?: number; pitch?: number; distance?: number };
}

// The tank: 2.4 m long, 1.5 m high, 1 m deep, on the ground.
const tank = { min: [-1.2, 0, -0.5], max: [1.2, 1.5, 0.5] } as const;
const sun = { x: 0.4, y: 0.75, z: 0.55 };

/**
 * A tank of water made of particles (`@fdw/engine-fluids`), on any physics
 * engine: a block of water falls and splashes against the far wall (a dam
 * that breaks), crates dropped in it push the water away and float on it.
 * Space drops a crate, P pours water in, R breaks the dam again. The orbit
 * camera: the mouse dragged, the arrows, the wheel.
 */
export function createSplash(
  engine: PhysicsEngine,
  options: SplashOptions = {},
): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const world = engine.createWorld();
    const physics = new ScenePhysics(scene, world);
    const renderer = new Renderer(backend);
    const sky = createSky(backend, { sun });
    const liquidRenderer = new ParticleFluidRenderer(renderer, {
      environment: sky,
      toneMapping: 'neutral',
      // Blue-green water: the red goes first.
      look: { absorption: [1.6, 0.5, 0.35], scatterColor: [0.01, 0.05, 0.07] },
    });
    const light = new DirectionalLight({
      direction: { x: -sun.x, y: -sun.y, z: -sun.z },
      diffuse: { x: 2.4, y: 2.25, z: 2 },
      ambient: { x: 0.35, y: 0.4, z: 0.5 },
    });
    scene.root.add().setLight(light);
    liquidRenderer.setSun(light);

    // --- The liquid.
    const liquid = new ParticleFluid(backend, {
      count: options.count ?? 16384,
      radius: options.radius ?? 0.02,
      bounds: { min: tank.min, max: tank.max },
    });
    const breakDam = () => {
      liquid.clear();
      liquid.addBlock(
        [tank.min[0], 0, tank.min[2]],
        [tank.min[0] + 0.9, 0.9, tank.max[2]],
      );
    };
    breakDam();
    const bodies = new FluidBodies(backend);
    const buoyancy = new Buoyancy(liquid, { density: 1000 });

    // --- The tank: a floor and walls, drawn but the front; for the physics, all.
    const pbr = new GraphBuilder('tank');
    pbr.surface({
      shadingModel: 'pbr',
      baseColor: pbr.uniform('color', BuiltinTypes.vec3f),
      roughness: 0.7,
    });
    const graph = pbr.build();
    const material = (color: number[]) =>
      new Material({ graph, values: { color } });
    const cube = createCube();
    const wall = 0.04;
    const [x0, y0, z0] = tank.min;
    const [x1, y1, z1] = tank.max;
    const slab = (
      center: { x: number; y: number; z: number },
      half: { x: number; y: number; z: number },
      color: number[] | undefined,
    ) => {
      const node = scene.root.add({
        position: center,
        scale: { x: half.x * 2, y: half.y * 2, z: half.z * 2 },
      });
      if (color) {
        node.setMesh(cube, material(color));
      }
      physics.add(node, {
        type: 'static',
        colliders: [{ shape: Shapes.box(half.x, half.y, half.z) }],
      });
    };
    const middle = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 };
    const half = { x: (x1 - x0) / 2, y: (y1 - y0) / 2, z: (z1 - z0) / 2 };
    // The ground, the floor of the tank.
    slab({ x: 0, y: -0.05, z: 0 }, { x: 6, y: 0.05, z: 6 }, [0.3, 0.29, 0.27]);
    slab({ ...middle, z: z0 - wall }, { ...half, z: wall }, [0.16, 0.2, 0.24]);
    slab({ ...middle, x: x0 - wall }, { ...half, x: wall }, [0.14, 0.17, 0.2]);
    slab({ ...middle, x: x1 + wall }, { ...half, x: wall }, [0.14, 0.17, 0.2]);
    slab({ ...middle, z: z1 + wall }, { ...half, z: wall }, undefined);

    // --- The crates.
    const crateMaterials = [
      [0.6, 0.38, 0.18],
      [0.75, 0.3, 0.15],
      [0.85, 0.72, 0.25],
    ].map(material);
    const crates: Node[] = [];
    const drop = () => {
      const size = 0.12 + 0.04 * (crates.length % 3);
      const node = scene.root.add({
        position: {
          x: -0.3 + 0.25 * Math.sin(crates.length * 2.1),
          y: 1.4,
          z: 0.2 * Math.cos(crates.length),
        },
        rotation: axisAngle(0.4, 1, 0.3, crates.length * 0.8),
        scale: { x: 2 * size, y: 2 * size, z: 2 * size },
      });
      node.setMesh(cube, crateMaterials[crates.length % 3]);
      const body = physics.add(node, {
        type: 'dynamic',
        colliders: [{ shape: Shapes.box(size), density: 500 }],
        angularDamping: 0.8,
      });
      const extents = { x: size, y: size, z: size };
      buoyancy.add(body, {
        points: boxPoints(extents),
        volume: 8 * size ** 3,
        drag: 2,
      });
      bodies.add(body);
      crates.push(node);
    };

    // --- The camera, in front of the tank.
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 50,
        aspect: 16 / 9,
        near: 0.05,
        far: 100,
      },
    });
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      ...OrbitActions,
      crate: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
      pour: { type: 'button', bindings: ['key:KeyP', 'gamepad:west'] },
      reset: { type: 'button', bindings: ['key:KeyR', 'gamepad:back'] },
    });
    const orbit = new OrbitOperator(camera, actions, {
      pivot: { x: 0, y: 0.45, z: 0 },
      distance: options.view?.distance ?? 3.6,
      yaw: options.view?.yaw ?? 0.3,
      pitch: options.view?.pitch ?? -0.28,
      minPitch: -1.4,
      maxPitch: 0.1,
      maxDistance: 12,
      moveSpeed: 0,
    });

    let pouring = false;
    const scheduler = new Scheduler();
    scheduler.add(
      'input',
      () => {
        input.update();
        followAspect(camera, surface);
        if (actions.button('reset').pressed) {
          crates.splice(0).forEach((node) => node.alive && node.remove());
          breakDam();
        }
        if (actions.button('crate').pressed) {
          drop();
        }
        if (actions.button('pour').pressed) {
          pouring = !pouring;
        }
        if (pouring) {
          // A stream from above the right of the tank, a few particles a frame.
          const r = liquid.layout.radius;
          const stream = particleBlock(
            liquid.layout,
            [0.7, 1.3, -0.05],
            [0.7 + 4 * r, 1.3 + 4 * r, -0.05 + 4 * r],
          );
          liquid.add(stream, [-1.5, -1, 0]);
        }
      },
      { phase: 'begin' },
    );
    buoyancy.install(scheduler);
    physics.install(scheduler);
    scheduler.add('camera', (dt) => orbit.update(dt), {
      after: ['physics:sync'],
    });

    let step = 1 / 60;
    scheduler.add(
      'render',
      () => {
        bodies.update();
        liquid.update(Math.min(step, 1 / 30), bodies);
        liquidRenderer.render({
          liquid,
          source: scene,
          camera,
          surface,
          clearColor: { r: 0.42, g: 0.55, b: 0.72, a: 1 },
        });
        context.info?.(
          `${liquid.active} particles · ${crates.length} crates · Space crate, P pour${pouring ? ' (on)' : ''}, R dam`,
        );
      },
      { phase: 'render' },
    );

    let last = 0;
    return {
      frame: (now) => {
        step = Math.min(now - last, 0.1);
        scheduler.update(step);
        last = now;
      },
      destroy: () => {
        input.dispose();
        physics.destroy();
        world.destroy();
        bodies.destroy();
        liquid.destroy();
        liquidRenderer.destroy();
        sky.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The tank on its own physics engine (see {@link createSplash}). */
export const createSplashScene = (engine: PhysicsEngine) =>
  createSplash(engine);
