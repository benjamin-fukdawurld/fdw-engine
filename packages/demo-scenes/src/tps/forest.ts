import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';
import type { Model } from '@fdw/engine-assets';
import { PhysicsWorld, Shapes } from '@fdw/engine-physics';
import { Scene, SceneLods, type LodLevel } from '@fdw/engine-scene';
import { fbm } from '@fdw/engine-noise';
import type { PortHandle } from '@fdw/engine-shader';
import {
  GraphBuilder,
  std,
  stdMacros,
  stdMapping,
  stdNoise,
} from '@fdw/engine-shader';
import { seededRandom } from '../maze/maze';
import { buildTerrain, terrainBase, type Terrain } from '../terrain/terrain';

// The forest of the TPS demo: a terrain in a bowl (a clearing in the
// middle, slopes too steep to climb around the play area), firs of three
// kinds and three levels of detail, ferns and grass near the camera.

/** The shape of the forest. */
export interface ForestOptions {
  // The side of the terrain, in meters.
  readonly size?: number;
  // The radius of the play area, inside the slopes.
  readonly playRadius?: number;
  // The firs: their least spacing, and the radius they are planted in.
  readonly treeSpacing?: number;
  readonly treeRadius?: number;
  // Clumps of grass and ferns per square meter of the play area.
  readonly coverDensity?: number;
  readonly seed?: number;
}

/** The textures of the ground: color, normals (OpenGL), roughness. */
export interface GroundTextures {
  readonly color: GpuTexture;
  readonly normal: GpuTexture;
  readonly roughness: GpuTexture;
}

/** The models of the forest, loaded. */
export interface ForestModels {
  // Nodes fir_<v> with their levels fir_<v>_LOD0..2.
  readonly fir: Model;
  // A node per plant.
  readonly fern: Model;
  readonly grass: Model;
  readonly ground: GroundTextures;
}

export interface Forest {
  readonly terrain: Terrain;
  readonly lods: SceneLods;
  // The firs: x, z, radius of the trunk.
  readonly trees: Float32Array;
  readonly treeCount: number;
  readonly playRadius: number;
  heightAt(x: number, z: number): number;
  destroy(): void;
}

const smoothstep = (low: number, high: number, x: number) => {
  const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * The heights of the forest, from 0 to 1 of `height`: gentle bumps, flat
 * in the clearing, rising steeply past the play area (a bowl the character
 * cannot climb out of).
 */
export function forestHeights(
  resolution: number,
  {
    size,
    height,
    playRadius,
    seed,
  }: {
    size: number;
    height: number;
    playRadius: number;
    seed: number;
  },
): Float32Array {
  const heights = new Float32Array(resolution * resolution);
  const octaves = {
    noise: 'simplex',
    octaves: 4,
    lacunarity: 2.2,
    gain: 0.45,
    seed,
  } as const;
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const x = ((i + 0.5) / resolution - 0.5) * size;
      const z = ((j + 0.5) / resolution - 0.5) * size;
      const r = Math.hypot(x, z);
      // Bumps of a few meters, every 30 m or so, none in the clearing: the
      // fbm of @fdw/engine-noise, the same as a material would compute.
      const bumps =
        2.6 * fbm([x / 30, z / 30], octaves) * smoothstep(12, 30, r);
      // The rim: 0 inside the play area, up to the full height past it,
      // steeper than the character can climb.
      const rim = smoothstep(playRadius + 4, playRadius + 40, r) * height * 0.9;
      heights[j * resolution + i] = Math.min(
        Math.max((height * 0.1 + bumps + rim) / height, 0),
        1,
      );
    }
  }
  return heights;
}

// The material of the ground: the forest floor of Poly Haven, repeated
// every 4 m, its normal map over the normal of the height map; its
// repetition broken by noises of the world position (patches of moss and
// of dry earth, the scan read at a second scale); the baked rock on the
// slopes, in triplanar mapping (no stretching where the uv of the terrain
// stretches), bumped by its height.
function groundMaterial(options: {
  size: number;
  height: number;
  resolution: number;
}) {
  const g = new GraphBuilder('forest ground');
  const { uv, normal } = terrainBase(g, options);
  const splat = (x: PortHandle) => g.call(std.vec3, { x, y: x, z: x });
  const tiled = g.call(std.mul, { a: uv, b: options.size / 4 });
  const sampler = g.sampler('groundSampler');
  const sample = (name: string, at: PortHandle = tiled) =>
    g.call(std.textureSample, { texture: g.texture(name), sampler, uv: at });
  const world = g.call(stdMapping.worldPosition);
  // Large patches, tens of meters: a fbm of the ground plane.
  const patches = g.call(
    stdNoise.fbm,
    { point: g.call(std.div, { a: world.swizzle('xz'), b: 23 }), seed: 11 },
    { params: { noise: 'simplex', octaves: 3 } },
  );
  const patch = g.call(std.smoothstep, { low: -0.35, high: 0.45, x: patches });
  // The scan, and the scan at a larger scale, mixed by the patches: the
  // tiles of the texture no longer line up.
  const scan = g.call(std.mix, {
    a: sample('groundColor').swizzle('rgb'),
    b: sample('groundColor', g.call(std.mul, { a: tiled, b: 0.37 })).swizzle(
      'rgb',
    ),
    t: splat(g.call(std.mul, { a: patch, b: 0.6 })),
  });
  // A little darker than the scan (under the canopy), greener or drier
  // from a patch to the next.
  const tint = g.call(std.mix, {
    a: [0.58, 0.68, 0.52],
    b: [0.72, 0.66, 0.55],
    t: splat(patch),
  });
  const color = g.call(std.mul, { a: scan, b: tint });
  // The rock where the ground is steep, its edge broken by a noise.
  const rock = g.call(stdMapping.triplanarTexture, {
    texture: g.texture('rock'),
    sampler,
    position: world,
    normal,
    scale: 1 / 6,
    sharpness: 6,
  });
  const steep = g.call(std.smoothstep, {
    low: 0.68,
    high: 0.86,
    x: g.call(std.add, {
      a: normal.swizzle('y'),
      b: g.call(std.mul, { a: patches, b: 0.08 }),
    }),
  });
  const rocky = g.call(std.sub, { a: 1, b: steep });
  const groundNormal = g.call(stdMacros.normalMapping, {
    sample: sample('groundNormal').swizzle('rgb'),
    uv: tiled,
    normal,
  });
  const rockNormal = g.call(stdMacros.bumpMapping, {
    height: rock.swizzle('a'),
    scale: 0.35,
    normal,
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: color,
      b: g.call(std.mul, { a: rock.swizzle('rgb'), b: [0.85, 0.83, 0.8] }),
      t: splat(rocky),
    }),
    roughness: g.call(std.mix, {
      a: sample('groundRoughness').swizzle('r'),
      b: 0.8,
      t: rocky,
    }),
    metallic: 0,
    normal: g.call(std.normalize, {
      x: g.call(std.mix, { a: groundNormal, b: rockNormal, t: splat(rocky) }),
    }),
  });
  return g.build();
}

// Points at least `spacing` apart in a disc, by dart throwing on a grid of
// cells of spacing / √2 (one point per cell at most).
function scatter(
  radius: number,
  spacing: number,
  random: () => number,
  keep: (x: number, z: number) => boolean,
): number[] {
  const cell = spacing / Math.SQRT2;
  const side = Math.ceil((2 * radius) / cell);
  const grid = new Int32Array(side * side).fill(-1);
  const points: number[] = [];
  const attempts = side * side * 4;
  for (let n = 0; n < attempts; n++) {
    const x = (random() * 2 - 1) * radius;
    const z = (random() * 2 - 1) * radius;
    if (x * x + z * z > radius * radius || !keep(x, z)) continue;
    const ci = Math.floor((x + radius) / cell);
    const cj = Math.floor((z + radius) / cell);
    let free = grid[cj * side + ci] < 0;
    for (let dj = -2; free && dj <= 2; dj++) {
      for (let di = -2; free && di <= 2; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= side || j >= side) continue;
        const other = grid[j * side + i];
        if (
          other >= 0 &&
          Math.hypot(points[other * 2] - x, points[other * 2 + 1] - z) < spacing
        ) {
          free = false;
        }
      }
    }
    if (free) {
      grid[cj * side + ci] = points.length / 2;
      points.push(x, z);
    }
  }
  return points;
}

// The nodes of a model by name.
const nodeIndex = (model: Model, name: string) =>
  model.data.nodes.findIndex((node) => node.name === name);

/**
 * Plants copies of nodes of a model as batches: per kind (a node of the
 * model, or its levels), per primitive, one createBatch of every copy of
 * that kind. Returns, per copy, the entities of each level.
 */
function plant(
  scene: Scene,
  model: Model,
  levels: readonly string[],
  transforms: { positions: number[]; rotations: number[]; scales: number[] },
  options: {
    castShadow: (level: number) => boolean;
    occluder?: (label: string) => boolean;
  },
): number[][][] {
  const count = transforms.positions.length / 3;
  // copies[copy][level] = entities.
  const copies: number[][][] = Array.from({ length: count }, () =>
    levels.map(() => []),
  );
  levels.forEach((name, level) => {
    const node = model.data.nodes[nodeIndex(model, name)];
    if (!node || node.mesh === undefined) {
      throw new Error(`The model has no mesh node ${name}`);
    }
    for (const primitive of model.meshes[node.mesh]) {
      const entities = scene.createBatch({
        count,
        ...transforms,
        mesh: primitive.mesh,
        material: primitive.material,
        castShadow: options.castShadow(level),
        static: true,
        occluder: options.occluder?.(primitive.material.label ?? '') ?? false,
      });
      entities.forEach((entity, copy) => copies[copy][level].push(entity));
    }
  });
  return copies;
}

/**
 * Builds the forest in a scene: the terrain (drawn as an item: give
 * `terrain.surface` to the renderer), the firs and the ground cover as
 * batches with their levels of detail (`lods`, to update with the camera),
 * and their bodies in the physics: the terrain as a heightfield, the
 * trunks as capsules.
 */
export function buildForest(
  backend: RenderBackend,
  scene: Scene,
  world: PhysicsWorld | undefined,
  models: ForestModels,
  // The rock of the slopes: color, and height in alpha (bakeRockTexture).
  rock: GpuTexture,
  options: ForestOptions = {},
): Forest {
  const size = options.size ?? 512;
  const height = 40;
  const resolution = 256;
  const playRadius = options.playRadius ?? 100;
  const seed = options.seed ?? 7;
  const heights = forestHeights(resolution, { size, height, playRadius, seed });
  const sampler = backend.textures.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    mipmapFilter: 'linear',
    wrapModeS: 'repeat',
    wrapModeT: 'repeat',
    maxAnisotropy: 8,
  });
  const terrain = buildTerrain(backend, {
    size,
    height,
    resolution,
    heights,
    patches: 32,
    edgePixels: 10,
    material: {
      graph: groundMaterial({ size, height, resolution }),
      values: {
        groundColor: models.ground.color,
        groundNormal: models.ground.normal,
        groundRoughness: models.ground.roughness,
        rock,
        groundSampler: sampler,
      },
    },
  });
  const heightAt = terrain.heightAt;
  const random = seededRandom(seed);
  const lods = new SceneLods(scene, { hysteresis: 0.15 });

  // The firs: none in the clearing, the three kinds mixed.
  const clearing = 16;
  const firs = scatter(
    options.treeRadius ?? 220,
    options.treeSpacing ?? 6,
    random,
    (x, z) => Math.hypot(x, z) > clearing,
  );
  const kinds = ['fir_a', 'fir_b', 'fir_c'];
  const byKind = kinds.map(() => ({
    positions: [] as number[],
    rotations: [] as number[],
    scales: [] as number[],
    trunks: [] as number[],
  }));
  for (let i = 0; i < firs.length; i += 2) {
    const [x, z] = [firs[i], firs[i + 1]];
    // The dead fir (c) is rarer.
    const roll = random();
    const kind = roll < 0.45 ? 0 : roll < 0.9 ? 1 : 2;
    const scale = 0.8 + random() * 0.45;
    const angle = random() * Math.PI * 2;
    const target = byKind[kind];
    // A little into the ground: the roots do not float on slopes.
    target.positions.push(x, heightAt(x, z) - 0.15, z);
    target.rotations.push(0, Math.sin(angle / 2), 0, Math.cos(angle / 2));
    target.scales.push(scale, scale, scale);
    target.trunks.push(x, z, 0.35 * scale);
  }
  const trees: number[] = [];
  kinds.forEach((kind, k) => {
    const transforms = byKind[k];
    if (transforms.positions.length === 0) return;
    const copies = plant(
      scene,
      models.fir,
      [0, 1, 2].map((level) => `${kind}_LOD${level}`),
      transforms,
      {
        castShadow: () => true,
        occluder: (label) => label.includes('trunk'),
      },
    );
    copies.forEach((levels, copy) => {
      const scale = transforms.scales[copy * 3];
      const lodLevels: LodLevel[] = [
        { nodes: levels[0], maxDistance: 30 * scale },
        { nodes: levels[1], maxDistance: 80 * scale },
        { nodes: levels[2], maxDistance: 320 },
      ];
      lods.add(levels[0][0], lodLevels);
    });
    trees.push(...transforms.trunks);
  });

  // Ground cover: clumps of grass and ferns in the play area, drawn near
  // the camera only (a single level).
  const cover = (
    model: Model,
    names: string[],
    density: number,
    near: number,
    size: number,
  ) => {
    const area = Math.PI * playRadius * playRadius;
    const count = Math.round(area * density);
    const perKind = names.map(() => ({
      positions: [] as number[],
      rotations: [] as number[],
      scales: [] as number[],
    }));
    for (let n = 0; n < count; n++) {
      const r = Math.sqrt(random()) * (playRadius + 10);
      const a = random() * Math.PI * 2;
      const [x, z] = [Math.cos(a) * r, Math.sin(a) * r];
      const target = perKind[Math.floor(random() * names.length)];
      const scale = size * (0.8 + random() * 0.6);
      const angle = random() * Math.PI * 2;
      target.positions.push(x, heightAt(x, z) - 0.02, z);
      target.rotations.push(0, Math.sin(angle / 2), 0, Math.cos(angle / 2));
      target.scales.push(scale, scale, scale);
    }
    names.forEach((name, k) => {
      if (perKind[k].positions.length === 0) return;
      const copies = plant(scene, model, [name], perKind[k], {
        castShadow: () => false,
      });
      for (const [level] of copies) {
        lods.add(level[0], [{ nodes: level, maxDistance: near }]);
      }
    });
  };
  const density = options.coverDensity ?? 0.12;
  // The lighter clumps of grass, every fern.
  // The clumps of grass of the scan are small: grown 2.5 times.
  cover(
    models.grass,
    ['grass_0', 'grass_2', 'grass_3', 'grass_5', 'grass_6', 'grass_7'],
    density,
    28,
    2.5,
  );
  cover(
    models.fern,
    ['fern_0', 'fern_1', 'fern_2', 'fern_3'],
    density * 0.25,
    40,
    1.2,
  );

  // The physics: the ground, and the trunks of the firs near the play area.
  if (world) {
    world.createBody({
      type: 'static',
      position: { x: 0, y: 0, z: 0 },
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
    for (let i = 0; i < trees.length; i += 3) {
      const [x, z, radius] = [trees[i], trees[i + 1], trees[i + 2]];
      if (Math.hypot(x, z) > playRadius + 20) continue;
      world.createBody({
        type: 'static',
        position: { x, y: heightAt(x, z) + 2, z },
        colliders: [{ shape: Shapes.capsule(2, radius) }],
      });
    }
  }

  return {
    terrain,
    lods,
    trees: Float32Array.from(trees),
    treeCount: trees.length / 3,
    playRadius,
    heightAt,
    destroy: () => {
      lods.destroy();
      terrain.destroy();
      sampler.destroy();
    },
  };
}
