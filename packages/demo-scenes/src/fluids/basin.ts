import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { FluidBodies, ShallowWater, WaterSurface } from '@fdw/engine-fluids';
import type { SourceHandle } from '@fdw/engine-fluids';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { fbm } from '@fdw/engine-noise';
import {
  boxPoints,
  Buoyancy,
  createSky,
  OceanRenderer,
} from '@fdw/engine-ocean';
import { PhysicsEngine, ScenePhysics, Shapes } from '@fdw/engine-physics';
import type { Node } from '@fdw/engine-scene';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '../geometry';
import { followAspect, SceneFactory } from '../scene';
import { buildTerrain, terrainBase } from '../terrain/terrain';

/** The options of the basin. */
export interface BasinOptions {
  /** The cells of the water along each side (128). */
  readonly resolution?: number;
  /** The crates floating at the start (5). */
  readonly crates?: number;
  /** Whether the spring on the hill runs at the start (true). */
  readonly spring?: boolean;
  /** Where the orbit camera starts: above the pond, the hill behind it. */
  readonly view?: { yaw?: number; pitch?: number; distance?: number };
}

// The valley: 48 m wide, its heights up to 12 m.
const size = 48;
const height = 12;
const resolution = 128;
// The pond, and the sill of its outlet.
const level = 3.2;
const spring = { x: -15, z: -13 };
const sun = { x: 0.5, y: 0.65, z: 0.45 };

// The distance from (x, z) to the segment a b.
function toSegment(
  x: number,
  z: number,
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.min(
    Math.max(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0),
    1,
  );
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

/**
 * The heights of a valley, in meters: a pond in a bowl, hills around, a
 * stream from a spring on a hill down to the pond, an outlet from the pond
 * to the east edge.
 */
export function basinGround(x: number, z: number): number {
  const r = Math.hypot(x, z * 1.15);
  // The bowl: its bottom at 0.6 m, its banks up to 8 m.
  let y = 0.6 + 7.4 * smooth(5, 19, r) + 1.2 * smooth(0, 5, r);
  // A hill to the north-west, the spring on it.
  y += 5 * Math.exp(-((x - spring.x) ** 2 + (z - spring.z) ** 2) / 50);
  y += fbm([x / 9, z / 9], { octaves: 3, seed: 4 }) * 0.6;
  // The stream: a channel from the spring down into the pond.
  const stream = toSegment(x, z, spring, { x: -4, z: -3 });
  y -=
    1.6 *
    Math.exp(-(stream * stream) / 2.5) *
    smooth(0, 2, Math.hypot(x - spring.x, z - spring.z));
  // The outlet: a channel east, its floor just under the pond.
  const outlet = Math.exp(-(z * z) / 3) * smooth(4, 8, x);
  y = y * (1 - outlet) + Math.min(y, 2.9 - (x - 8) * 0.02) * outlet;
  return y;
}

const smooth = (low: number, high: number, x: number) => {
  const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * The material of a terrain of `buildTerrain` along water: wet sand under
 * the water and along it, grass above, rock on the slopes. `level` is the
 * height of the water, in meters.
 */
export function shoreGraph(options: {
  readonly size: number;
  readonly height: number;
  readonly resolution: number;
  readonly level: number;
}) {
  const { level } = options;
  const g = new GraphBuilder('shore');
  const { vertex, normal } = terrainBase(g, options);
  const y = g.call(std.mul, {
    a: g.call(std.perFragment, { value: vertex.height }),
    b: options.height,
  });
  const splat = (value: PortHandle) =>
    g.call(std.vec3, { x: value, y: value, z: value });
  const between = (low: number, high: number) =>
    splat(g.call(std.smoothstep, { low, high, x: y }));
  const sand = g.call(std.mix, {
    a: [0.25, 0.2, 0.14],
    b: [0.5, 0.43, 0.3],
    t: between(level - 0.8, level + 0.3),
  });
  const ground = g.call(std.mix, {
    a: sand,
    b: [0.22, 0.32, 0.12],
    t: between(level + 0.6, level + 1.6),
  });
  const rocky = g.call(std.sub, {
    a: 1,
    b: g.call(std.smoothstep, { low: 0.6, high: 0.8, x: normal.swizzle('y') }),
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: ground,
      b: [0.38, 0.35, 0.32],
      t: splat(rocky),
    }),
    roughness: 0.9,
    normal,
  });
  return g.build();
}

/**
 * A pond in a valley, its water simulated on the GPU as a field of heights
 * (`@fdw/engine-fluids`), on any physics engine: a spring on a hill runs
 * down a stream into the pond, which overflows by an outlet; crates and
 * balls dropped in it make waves and float, carried by the current. Space
 * drops a crate, B a ball, E a splash of water, F stops or starts the
 * spring, R starts again. The orbit camera: the mouse dragged, the arrows,
 * the wheel.
 */
export function createBasin(
  engine: PhysicsEngine,
  options: BasinOptions = {},
): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const world = engine.createWorld();
    const physics = new ScenePhysics(scene, world);
    const renderer = new Renderer(backend);
    const oceanRenderer = new OceanRenderer(renderer, {
      toneMapping: 'neutral',
    });
    const n = options.resolution ?? resolution;
    const cell = size / n;

    // --- The sky, the sun.
    const sky = createSky(backend, { sun });
    const light = new DirectionalLight({
      direction: { x: -sun.x, y: -sun.y, z: -sun.z },
      castShadow: false,
      diffuse: { x: 2.6, y: 2.45, z: 2.2 },
      ambient: { x: 0.32, y: 0.38, z: 0.48 },
    });
    scene.root.add().setLight(light);

    // --- The valley: a terrain of patches, a heightfield for the physics,
    // the ground of the water: the same heights at the centers of the cells.
    const heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * cell - size / 2;
        const z = (j + 0.5) * cell - size / 2;
        heights[j * n + i] = basinGround(x, z) / height;
      }
    }
    const terrain = buildTerrain(backend, {
      size,
      height,
      resolution: n,
      heights,
      material: { graph: shoreGraph({ size, height, resolution: n, level }) },
    });
    physics.add(scene.root.add(), {
      type: 'static',
      colliders: [
        {
          shape: Shapes.heightfield(n, n, heights, {
            x: size * (1 - 1 / n),
            y: height,
            z: size * (1 - 1 / n),
          }),
          material: { friction: 0.8 },
        },
      ],
    });

    // --- The water: the pond up to its level, the outlet open to the east.
    const water = new ShallowWater(backend, {
      resolution: [n, n],
      cell,
      origin: { x: -size / 2, z: -size / 2 },
      ground: heights.map((h) => h * height),
      level,
      edges: 'open',
      maxDepth: 3,
      damping: 0.15,
    });
    const waterSurface = new WaterSurface(water, { environment: sky }).setSun(
      light,
      1.2,
    );
    let springSource: SourceHandle | undefined;
    const setSpring = (on: boolean) => {
      springSource?.remove();
      springSource = on
        ? water.addSource({ x: spring.x, z: spring.z, radius: 1.2, rate: 1.5 })
        : undefined;
    };
    setSpring(options.spring ?? true);
    // What floats asks the water; the water feels what is in it.
    const buoyancy = new Buoyancy(water, { density: 1000 });
    const bodies = new FluidBodies(backend);

    // --- What floats: crates, balls.
    const pbr = new GraphBuilder('floating');
    pbr.surface({
      shadingModel: 'pbr',
      baseColor: pbr.uniform('color', BuiltinTypes.vec3f),
      roughness: 0.6,
    });
    const graph = pbr.build();
    const colors = [
      [0.55, 0.36, 0.18],
      [0.7, 0.25, 0.12],
      [0.85, 0.75, 0.2],
      [0.2, 0.45, 0.7],
    ].map((color) => new Material({ graph, values: { color } }));
    const cube = createCube();
    const sphere = createSphere(24, 16);
    const floating: Node[] = [];
    let dropped = 0;
    const drop = (
      kind: 'crate' | 'ball',
      x: number,
      z: number,
      y = level + 3,
    ) => {
      const half = 0.35 + 0.12 * (dropped % 3);
      const node = scene.root.add({
        position: { x, y, z },
        rotation: axisAngle(0.3, 1, 0.2, dropped * 0.9),
        scale: { x: 2 * half, y: 2 * half, z: 2 * half },
      });
      node.setMesh(
        kind === 'crate' ? cube : sphere,
        colors[dropped % colors.length],
      );
      const shape = kind === 'crate' ? Shapes.box(half) : Shapes.sphere(half);
      const body = physics.add(node, {
        type: 'dynamic',
        colliders: [{ shape, density: kind === 'crate' ? 500 : 350 }],
        angularDamping: 0.6,
      });
      const volume =
        kind === 'crate' ? 8 * half ** 3 : (4 / 3) * Math.PI * half ** 3;
      const extents = { x: half, y: half, z: half };
      const points =
        kind === 'crate'
          ? boxPoints(extents)
          : boxPoints({ x: half * 0.7, y: half * 0.7, z: half * 0.7 });
      buoyancy.add(body, { points, volume, drag: 1.5 });
      bodies.add(body);
      floating.push(node);
      dropped++;
    };
    const reset = () => {
      floating.splice(0).forEach((node) => node.alive && node.remove());
      dropped = 0;
      water.reset();
      const crates = options.crates ?? 5;
      for (let i = 0; i < crates; i++) {
        const angle = i * 2.4;
        drop(
          i % 2 ? 'ball' : 'crate',
          Math.cos(angle) * (2 + i),
          Math.sin(angle) * (1.5 + i * 0.8),
          level + 0.6,
        );
      }
    };
    reset();

    // --- The camera, above the pond.
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 55,
        aspect: 16 / 9,
        near: 0.1,
        far: 500,
      },
    });
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      ...OrbitActions,
      crate: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
      ball: { type: 'button', bindings: ['key:KeyB', 'gamepad:west'] },
      splash: { type: 'button', bindings: ['key:KeyE', 'gamepad:east'] },
      spring: { type: 'button', bindings: ['key:KeyF', 'gamepad:north'] },
      reset: { type: 'button', bindings: ['key:KeyR', 'gamepad:back'] },
    });
    const orbit = new OrbitOperator(camera, actions, {
      pivot: { x: -4, y: level, z: -3 },
      distance: options.view?.distance ?? 30,
      yaw: options.view?.yaw ?? 0.6,
      pitch: options.view?.pitch ?? -0.5,
      minPitch: -1.4,
      maxPitch: -0.05,
      maxDistance: 80,
      moveSpeed: 8,
    });

    const scheduler = new Scheduler();
    scheduler.add(
      'input',
      () => {
        input.update();
        followAspect(camera, surface);
        const { x, z } = orbit.pivot;
        if (actions.button('reset').pressed) {
          reset();
        }
        if (actions.button('crate').pressed) {
          drop('crate', x + Math.sin(dropped) * 2, z + Math.cos(dropped) * 2);
        }
        if (actions.button('ball').pressed) {
          drop('ball', x + Math.sin(dropped) * 2, z + Math.cos(dropped) * 2);
        }
        if (actions.button('splash').pressed) {
          water.splash(x, z, 1.5, 6);
        }
        if (actions.button('spring').pressed) {
          setSpring(!springSource);
        }
      },
      { phase: 'begin' },
    );
    buoyancy.install(scheduler);
    physics.install(scheduler);
    scheduler.add('camera', (dt) => orbit.update(dt), {
      after: ['physics:sync'],
    });

    let time = 0;
    let step = 1 / 60;
    scheduler.add(
      'render',
      () => {
        bodies.update();
        water.update(step, bodies);
        terrain.surface.update(camera, surface);
        oceanRenderer.render({
          ocean: waterSurface,
          source: scene,
          items: [terrain.surface],
          camera,
          surface,
          time,
        });
        context.info?.(
          `shallow water ${n}² · ${floating.length} floating · spring ${springSource ? 'on' : 'off'} · Space crate, B ball, E splash, F spring, R reset`,
        );
      },
      { phase: 'render' },
    );

    let last = 0;
    return {
      frame: (now) => {
        time = now;
        step = Math.min(now - last, 0.1);
        scheduler.update(step);
        last = now;
      },
      destroy: () => {
        input.dispose();
        physics.destroy();
        world.destroy();
        bodies.destroy();
        waterSurface.destroy();
        water.destroy();
        terrain.destroy();
        sky.destroy();
        oceanRenderer.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The basin on its own physics engine (see {@link createBasin}). */
export const createBasinScene = (engine: PhysicsEngine) => createBasin(engine);
