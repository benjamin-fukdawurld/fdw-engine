import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { fbm, ridged } from '@fdw/engine-noise';
import {
  boxPoints,
  Buoyancy,
  createSky,
  GerstnerWaves,
  Ocean,
  OceanRenderer,
  OceanSpectrum,
} from '@fdw/engine-ocean';
import type { Waves } from '@fdw/engine-ocean';
import { PhysicsEngine, ScenePhysics, Shapes } from '@fdw/engine-physics';
import type { Node } from '@fdw/engine-scene';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import { axisAngle, createCube } from '../geometry';
import { followAspect, SceneFactory } from '../scene';
import { buildTerrain, terrainBase } from '../terrain/terrain';
import { createBoat } from './boat';

/** The shape of the coast and of the sea. */
export interface CoastOptions {
  /** The waves: the ocean spectrum (FFT), or sums of Gerstner waves. */
  readonly waves?: 'spectrum' | 'gerstner';
  /** The speed of the wind of the spectrum, in m/s (9). */
  readonly windSpeed?: number;
  /** The crates floating at the start (8). */
  readonly crates?: number;
  /** Where the orbit camera starts: around the boat, out at sea. */
  readonly view?: { yaw?: number; pitch?: number; distance?: number };
}

// The terrain: 480 m wide, 48 m high, the sea at 12 m.
const size = 480;
const height = 48;
const resolution = 256;
const seaLevel = 12;
const sun = { x: 0.55, y: 0.6, z: -0.58 };

/**
 * The heights of a coast, from 0 to 1: a beach along a curved shore, hills
 * and a rocky headland on the land (-z), the sea floor going down toward
 * +z.
 */
export function coastHeights(): Float32Array {
  const heights = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const x = ((i + 0.5) / resolution - 0.5) * size;
      const z = ((j + 0.5) / resolution - 0.5) * size;
      // The distance from the shore, out to sea; a bay in the middle.
      const shore = z + 26 * Math.sin(x / 70) - 18 * Math.exp(-((x / 60) ** 2));
      const land = Math.max(-shore, 0);
      let y = seaLevel - 9 * Math.tanh(shore / 45) + 0.6;
      y +=
        (fbm([x / 90, z / 90], { octaves: 4, seed: 5 }) * 0.5 + 0.5) *
        Math.min(land / 60, 1) *
        14;
      // A rocky headland to the east, into the sea.
      const headland = Math.exp(
        -(((x - 120) / 45) ** 2) - ((z - 10) / 70) ** 2,
      );
      y +=
        headland * (10 + ridged([x / 30, z / 30], { octaves: 4, seed: 2 }) * 8);
      // The sea floor, a little uneven.
      y += fbm([x / 25, z / 25], { octaves: 3, seed: 11 }) * 0.8;
      heights[j * resolution + i] = Math.min(Math.max(y / height, 0), 1);
    }
  }
  return heights;
}

// Sand along the water, wet below it; grass up the beach; rock on the
// slopes.
function coastGraph() {
  const g = new GraphBuilder('coast');
  const { vertex, normal } = terrainBase(g, { size, height, resolution });
  const y = g.call(std.mul, {
    a: g.call(std.perFragment, { value: vertex.height }),
    b: height,
  });
  const splat = (value: PortHandle) =>
    g.call(std.vec3, { x: value, y: value, z: value });
  const between = (low: number, high: number) =>
    splat(g.call(std.smoothstep, { low, high, x: y }));
  const sand = g.call(std.mix, {
    a: [0.34, 0.27, 0.17],
    b: [0.76, 0.66, 0.47],
    t: between(seaLevel - 0.6, seaLevel + 0.4),
  });
  const ground = g.call(std.mix, {
    a: sand,
    b: [0.2, 0.3, 0.1],
    t: between(seaLevel + 2.5, seaLevel + 5),
  });
  const rocky = g.call(std.sub, {
    a: 1,
    b: g.call(std.smoothstep, { low: 0.62, high: 0.8, x: normal.swizzle('y') }),
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: ground,
      b: [0.36, 0.34, 0.31],
      t: splat(rocky),
    }),
    roughness: 0.9,
    normal,
  });
  return g.build();
}

/**
 * A coast, a sea and things floating on it, on any physics engine: the
 * ocean spectrum computed on the GPU (or Gerstner waves: G switches), the
 * water seen through down to the sand, crates and a rowing boat carried by
 * the waves (their heights read back from the GPU, a frame late). Space
 * drops a crate, R starts again. The orbit camera: the mouse dragged, the
 * arrows, the wheel.
 */
export function createCoast(
  engine: PhysicsEngine,
  options: CoastOptions = {},
): SceneFactory {
  return (backend, surface, context = {}) => {
    const scene = new Scene();
    const world = engine.createWorld();
    const physics = new ScenePhysics(scene, world);
    const renderer = new Renderer(backend);
    const oceanRenderer = new OceanRenderer(renderer, {
      toneMapping: 'neutral',
    });

    // --- The sky, the sun.
    const sky = createSky(backend, { sun });
    const light = new DirectionalLight({
      direction: { x: -sun.x, y: -sun.y, z: -sun.z },
      castShadow: true,
      diffuse: { x: 2.6, y: 2.45, z: 2.2 },
      ambient: { x: 0.32, y: 0.38, z: 0.48 },
    });
    scene.root.add().setLight(light);

    // --- The coast: drawn as a terrain of patches, a heightfield for the
    // physics.
    const heights = coastHeights();
    const terrain = buildTerrain(backend, {
      size,
      height,
      resolution,
      heights,
      material: { graph: coastGraph() },
    });
    physics.add(scene.root.add(), {
      type: 'static',
      colliders: [
        {
          shape: Shapes.heightfield(resolution, resolution, heights, {
            x: size * (1 - 1 / resolution),
            y: height,
            z: size * (1 - 1 / resolution),
          }),
          material: { friction: 0.8 },
        },
      ],
    });

    // --- The sea: the spectrum, or Gerstner waves; an ocean for each.
    const spectrum = new OceanSpectrum(backend, {
      windSpeed: options.windSpeed ?? 9,
      windDirection: Math.PI / 2 + 0.3,
      choppiness: 0.9,
    });
    const gerstner = new GerstnerWaves([
      {
        direction: Math.PI / 2 + 0.2,
        wavelength: 34,
        amplitude: 0.55,
        steepness: 0.7,
      },
      {
        direction: Math.PI / 2 - 0.5,
        wavelength: 19,
        amplitude: 0.3,
        steepness: 0.6,
      },
      {
        direction: Math.PI / 2 + 0.9,
        wavelength: 11,
        amplitude: 0.16,
        steepness: 0.5,
      },
      {
        direction: Math.PI / 2 - 1.1,
        wavelength: 6.3,
        amplitude: 0.08,
        steepness: 0.5,
      },
      {
        direction: Math.PI / 2 + 0.4,
        wavelength: 3.1,
        amplitude: 0.035,
        steepness: 0.4,
      },
      {
        direction: Math.PI / 2 - 0.2,
        wavelength: 1.7,
        amplitude: 0.015,
        steepness: 0.3,
      },
    ]);
    const oceanOf = (waves: Waves) =>
      new Ocean({ waves, environment: sky, level: seaLevel }).setSun(
        light,
        1.2,
      );
    const oceans = { spectrum: oceanOf(spectrum), gerstner: oceanOf(gerstner) };
    let current: keyof typeof oceans = options.waves ?? 'spectrum';
    // What floats asks the ocean drawn.
    const water = {
      heightAt: (x: number, z: number) => oceans[current].heightAt(x, z),
    };
    const buoyancy = new Buoyancy(water);

    // --- What floats: crates, a boat.
    const pbr = new GraphBuilder('floating');
    pbr.surface({
      shadingModel: 'pbr',
      baseColor: pbr.uniform('color', BuiltinTypes.vec3f),
      roughness: 0.7,
    });
    const graph = pbr.build();
    const crateMaterials = [
      [0.55, 0.36, 0.18],
      [0.62, 0.45, 0.24],
      [0.7, 0.25, 0.12],
    ].map((color) => new Material({ graph, values: { color } }));
    const cube = createCube();
    const floating: Node[] = [];
    let dropped = 0;
    const dropCrate = (x: number, z: number, y = seaLevel + 1) => {
      const half = 0.4 + 0.15 * (dropped % 3);
      const node = scene.root.add({
        position: { x, y, z },
        rotation: axisAngle(0, 1, 0, dropped * 0.7),
        scale: { x: 2 * half, y: 2 * half, z: 2 * half },
      });
      node.setMesh(cube, crateMaterials[dropped % 3]);
      const body = physics.add(node, {
        type: 'dynamic',
        colliders: [{ shape: Shapes.box(half), density: 450 }],
      });
      const extents = { x: half, y: half, z: half };
      buoyancy.add(body, { points: boxPoints(extents), volume: 8 * half ** 3 });
      floating.push(node);
      dropped++;
    };
    const boat = createBoat();
    const boatMaterial = new Material({
      graph,
      values: { color: [0.45, 0.2, 0.1] },
      renderState: { doubleSided: true },
    });
    const launch = () => {
      const node = scene.root.add({
        position: { x: -6, y: seaLevel + 0.3, z: 34 },
        rotation: axisAngle(0, 1, 0, 0.9),
      });
      node.setMesh(boat.mesh, boatMaterial);
      // A light hull (150 kg), and the weight of the rowers and their gear
      // low in it (300 kg): the center of mass under the water keeps it
      // upright. The water damps its rolling and its bobbing.
      const body = physics.add(node, {
        type: 'dynamic',
        colliders: [
          { shape: Shapes.convex(boat.hull), density: 50 },
          {
            shape: Shapes.box(0.3, 0.05, 0.9),
            position: { y: -0.3 },
            density: 2800,
          },
        ],
        angularDamping: 1.5,
      });
      buoyancy.add(body, {
        points: boat.floats,
        volume: boat.volume,
        depth: boat.depth,
        drag: 3,
      });
      floating.push(node);
    };
    const reset = () => {
      floating.splice(0).forEach((node) => node.alive && node.remove());
      dropped = 0;
      launch();
      const crates = options.crates ?? 8;
      for (let i = 0; i < crates; i++) {
        const angle = i * 2.4;
        const radius = 5 + i * 1.6;
        dropCrate(
          -6 + Math.cos(angle) * radius,
          30 + Math.sin(angle) * radius * 0.6,
        );
      }
    };
    reset();

    // --- The camera, out at sea, looking at the coast.
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 55,
        aspect: 16 / 9,
        near: 0.2,
        far: 4000,
      },
    });
    const input = new Input(context.input ?? new FakeInputSource());
    const actions = new ActionMap(input, {
      ...OrbitActions,
      waves: { type: 'button', bindings: ['key:KeyG', 'gamepad:north'] },
      drop: { type: 'button', bindings: ['key:Space', 'gamepad:south'] },
      reset: { type: 'button', bindings: ['key:KeyR', 'gamepad:back'] },
    });
    const orbit = new OrbitOperator(camera, actions, {
      pivot: { x: -4, y: seaLevel + 1, z: 26 },
      distance: options.view?.distance ?? 30,
      yaw: options.view?.yaw ?? -0.25,
      pitch: options.view?.pitch ?? -0.2,
      minPitch: -1.4,
      maxPitch: 0.1,
      maxDistance: 300,
      moveSpeed: 12,
    });

    const scheduler = new Scheduler();
    scheduler.add(
      'input',
      () => {
        input.update();
        followAspect(camera, surface);
        if (actions.button('waves').pressed) {
          current = current === 'spectrum' ? 'gerstner' : 'spectrum';
        }
        if (actions.button('reset').pressed) {
          reset();
        }
        if (actions.button('drop').pressed) {
          // Ahead of the camera, on the water.
          const { x, z } = orbit.pivot;
          dropCrate(
            x + Math.sin(dropped) * 3,
            z + Math.cos(dropped) * 3,
            seaLevel + 6,
          );
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
    scheduler.add(
      'render',
      () => {
        const ocean = oceans[current];
        ocean.update(camera.position, time);
        terrain.surface.update(camera, surface);
        oceanRenderer.render({
          ocean,
          source: scene,
          items: [terrain.surface],
          camera,
          surface,
          time,
        });
        context.info?.(
          `${current === 'spectrum' ? 'ocean spectrum (FFT)' : 'Gerstner waves'} · ${floating.length} floating · G waves, Space crate, R reset`,
        );
      },
      { phase: 'render' },
    );

    let last = 0;
    return {
      frame: (now) => {
        time = now;
        scheduler.update(Math.min(now - last, 0.1));
        last = now;
      },
      destroy: () => {
        input.dispose();
        physics.destroy();
        world.destroy();
        oceans.spectrum.destroy();
        oceans.gerstner.destroy();
        spectrum.destroy();
        terrain.destroy();
        sky.destroy();
        oceanRenderer.destroy();
        renderer.destroy();
      },
    };
  };
}

/** The coast on its own physics engine (see {@link createCoast}). */
export const createCoastScene = (engine: PhysicsEngine) => createCoast(engine);
