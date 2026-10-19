import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { fbm, random, ridged } from '@fdw/engine-noise';
import {
  GraphBuilder,
  std,
  stdMacros,
  stdMapping,
  stdNoise,
} from '@fdw/engine-shader';
import type { PortHandle } from '@fdw/engine-shader';
import {
  axisAngle,
  bakeRockTexture,
  buildTerrain,
  createSphere,
  followAspect,
  rockGraph,
  terrainBase,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A terrain made of noises, on both sides: its heights computed on the CPU
// by @fdw/engine-noise, its ground painted on the GPU by the same noises of
// the material graph. Moss grows where a fbm is high; the CPU computes the
// same fbm to set boulders on the moss, at the height of the ground. The
// rock of the slopes is baked once, then read in triplanar mapping.
const example: Example = async ({ backend, surface, onFrame }) => {
  const size = 240;
  const height = 34;
  const resolution = 256;

  // --- The heights, on the CPU: ridges and hills, flattened in the middle.
  const heights = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const x = ((i + 0.5) / resolution - 0.5) * size;
      const z = ((j + 0.5) / resolution - 0.5) * size;
      const p = [x / 80, z / 80];
      const crests = ridged(p, { noise: 'simplex', octaves: 5, seed: 4 });
      const hills = fbm(p, { octaves: 4, seed: 9 }) * 0.5 + 0.5;
      const middle = Math.min(Math.hypot(x, z) / 60, 1);
      heights[j * resolution + i] =
        (0.15 + 0.85 * middle * crests) * 0.6 + hills * 0.25;
    }
  }

  // --- The moss: the same fbm on both sides, from the world position.
  const moss = { noise: 'simplex', octaves: 3, seed: 21 } as const;
  const mossScale = 1 / 14;

  // --- The ground, on the GPU.
  const g = new GraphBuilder('procedural ground');
  const { normal } = terrainBase(g, { size, height, resolution });
  const splat = (x: PortHandle) => g.call(std.vec3, { x, y: x, z: x });
  const world = g.call(stdMapping.worldPosition);
  const patches = g.call(
    stdNoise.fbm,
    {
      point: g.call(std.mul, { a: world.swizzle('xz'), b: mossScale }),
      seed: moss.seed,
    },
    { params: { noise: moss.noise, octaves: moss.octaves } },
  );
  const mossy = g.call(std.smoothstep, { low: 0.15, high: 0.3, x: patches });
  // Grass with a fine variation, faded where it is smaller than the pixel.
  const detail = g.call(
    stdNoise.fbm,
    { point: g.call(std.mul, { a: world.swizzle('xz'), b: 0.7 }) },
    { params: { noise: 'value', octaves: 4, filtered: true } },
  );
  const grass = g.call(std.mix, {
    a: [0.15, 0.22, 0.07],
    b: [0.3, 0.32, 0.13],
    t: splat(
      g.call(std.add, { a: g.call(std.mul, { a: detail, b: 0.5 }), b: 0.5 }),
    ),
  });
  const ground = g.call(std.mix, {
    a: grass,
    b: [0.05, 0.12, 0.04],
    t: splat(mossy),
  });
  // The baked rock on the slopes, in triplanar mapping.
  const rock = g.call(stdMapping.triplanarTexture, {
    texture: g.texture('rock'),
    sampler: g.sampler('rockSampler'),
    normal,
    scale: 1 / 5,
    sharpness: 6,
  });
  const rocky = g.call(std.sub, {
    a: 1,
    b: g.call(std.smoothstep, {
      low: 0.72,
      high: 0.86,
      x: normal.swizzle('y'),
    }),
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: ground,
      b: rock.swizzle('rgb'),
      t: splat(rocky),
    }),
    roughness: 0.9,
    metallic: 0,
    normal: g.call(stdMacros.bumpMapping, {
      height: g.call(std.mul, { a: rock.swizzle('a'), b: rocky }),
      scale: 0.3,
      normal,
    }),
  });

  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });
  const rockTexture = await bakeRockTexture(renderer);
  const terrain = buildTerrain(backend, {
    size,
    height,
    resolution,
    heights,
    material: {
      graph: g.build(),
      values: {
        rock: rockTexture,
        rockSampler: backend.textures.createSampler({
          minFilter: 'linear',
          magFilter: 'linear',
          mipmapFilter: 'linear',
          wrapModeS: 'repeat',
          wrapModeT: 'repeat',
          maxAnisotropy: 8,
        }),
      },
    },
  });

  // --- The boulders, on the CPU: one candidate per cell of 5 m, moved in
  // its cell by a random of the cell, kept where the moss grows (the fbm
  // of the material) and the ground is not too steep.
  const boulders: RenderItem[] = [];
  const sphere = createSphere(24, 12);
  const stone = new Material({ graph: rockGraph() });
  const cell = 5;
  for (let cz = -20; cz < 20; cz++) {
    for (let cx = -20; cx < 20; cx++) {
      const [jx, jz, r] = random([cx, cz, 0], 3);
      const x = (cx + jx) * cell;
      const z = (cz + jz) * cell;
      if (fbm([x * mossScale, z * mossScale], moss) < 0.3) continue;
      const y = terrain.heightAt(x, z);
      const slope =
        Math.abs(terrain.heightAt(x + 1, z) - y) +
        Math.abs(terrain.heightAt(x, z + 1) - y);
      if (slope > 0.5) continue;
      const scale = 0.8 + r * 1.4;
      boulders.push({
        mesh: sphere,
        material: stone,
        transform: new Transform({
          position: { x, y: y + scale * 0.2, z },
          rotation: axisAngle(0.3, 1, 0.2, r * 6),
          scale: { x: scale * 1.3, y: scale * 0.75, z: scale },
        }),
      });
    }
  }

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 55,
      aspect: 16 / 9,
      near: 0.5,
      far: 600,
    },
  });
  const sun = new DirectionalLight({
    direction: { x: -0.6, y: -0.5, z: -0.45 },
    ambient: { x: 0.3, y: 0.33, z: 0.38 },
    diffuse: { x: 1.5, y: 1.42, z: 1.25 },
  });

  onFrame((time) => {
    const angle = 0.6 + time * 0.03;
    const x = Math.sin(angle) * 70;
    const z = Math.cos(angle) * 70;
    camera.position = { x, y: terrain.heightAt(x, z) + 22, z };
    const turn = axisAngle(0, 1, 0, angle);
    const tilt = axisAngle(1, 0, 0, -0.32);
    camera.rotation = {
      x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
      y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
      z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
      w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
    };
    followAspect(camera, surface);
    terrain.surface.update(camera, surface);
    renderer.render({
      items: [terrain.surface, ...boulders],
      lights: [sun],
      camera,
      surface,
      clearColor: { r: 0.62, g: 0.72, b: 0.85, a: 1 },
    });
  });
};

export default example;
