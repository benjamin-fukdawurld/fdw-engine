import { DirectionalLight, Material, Mesh } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import {
  BuiltinTypes,
  GraphBuilder,
  PortHandle,
  std,
} from '@fdw/engine-shader';
import { axisAngle, createCube } from '../geometry';
import { seededRandom } from '../maze/maze';

// A city of blocks of buildings, for the occlusion culling: from the street,
// the first buildings hide almost all the others.

/** The plan of a city: square blocks between streets. */
export interface CityPlan {
  // Blocks per side.
  readonly blocks: number;
  // The side of a block, and the width of the streets, in meters.
  readonly block: number;
  readonly street: number;
}

export const defaultCityPlan: CityPlan = { blocks: 24, block: 42, street: 14 };

/** What a city is made of, once built in a scene. */
export interface City {
  readonly plan: CityPlan;
  // From the center to the edge, in meters.
  readonly half: number;
  // The x (or z) of the middle of the streets, from one edge to the other.
  readonly streets: readonly number[];
  readonly buildings: readonly Node[];
  readonly sun: DirectionalLight;
  readonly cube: Mesh;
}

/**
 * A facade: a wall of a color, with rows of windows drawn from the world
 * position (a floor every 3.2 m), and a plain roof.
 */
export function facadeMaterial(color: [number, number, number]): Material {
  const g = new GraphBuilder('facade');
  const world = g
    .call(std.perFragment, {
      value: g.call(std.transform, {
        matrix: g.engine('object.world'),
        vector: g.call(std.extend, {
          xyz: g.attribute('position', BuiltinTypes.vec3f),
          w: 1,
        }),
      }),
    })
    .swizzle('xyz');
  // 1 in a part of each period of a value, from low to high.
  const band = (
    value: PortHandle,
    period: number,
    low: number,
    high: number
  ) => {
    const t = g.call(std.fract, {
      x: g.call(std.div, { a: value, b: period }),
    });
    return g.call(std.mul, {
      a: g.call(std.step, { edge: low, x: t }),
      b: g.call(std.step, { edge: t, x: high }),
    });
  };
  const floors = band(world.swizzle('y'), 3.2, 0.35, 0.85);
  const columns = band(
    g.call(std.add, { a: world.swizzle('x'), b: world.swizzle('z') }),
    2.6,
    0.2,
    0.8
  );
  // No window on the roof.
  const wall = g.call(std.step, {
    edge: g.attribute('normal', BuiltinTypes.vec3f).swizzle('y'),
    x: 0.5,
  });
  const window = g.call(std.mul, {
    a: g.call(std.mul, { a: floors, b: columns }),
    b: wall,
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: g.uniform('color', BuiltinTypes.vec3f),
      b: [0.08, 0.1, 0.14],
      t: window,
    }),
    roughness: g.call(std.mix, { a: 0.85, b: 0.2, t: window }),
  });
  return new Material({
    graph: g.build(),
    values: { color },
    label: 'facade',
  });
}

function plainMaterial(color: [number, number, number], roughness: number) {
  const g = new GraphBuilder('plain');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  return new Material({ graph: g.build(), values: { color, roughness } });
}

const facadeColors: [number, number, number][] = [
  [0.62, 0.58, 0.52],
  [0.55, 0.36, 0.3],
  [0.7, 0.68, 0.64],
  [0.42, 0.45, 0.5],
  [0.66, 0.55, 0.4],
  [0.5, 0.5, 0.46],
];

/**
 * Builds a city in a scene: on each block, 3 × 3 buildings of random
 * heights (taller towards the center), static and occluders; sidewalks, a
 * ground, and a sun casting shadows.
 */
export function buildCity(
  scene: Scene,
  plan: CityPlan = defaultCityPlan,
  seed = 3
): City {
  const { blocks, block, street } = plan;
  const random = seededRandom(seed);
  const cube = createCube();
  const pitch = block + street;
  const half = (blocks * pitch) / 2;
  const facades = facadeColors.map(facadeMaterial);
  const sidewalk = plainMaterial([0.5, 0.49, 0.47], 0.9);
  const ground = plainMaterial([0.18, 0.18, 0.19], 0.95);

  const city = scene.root.add({ name: 'city', static: true });
  city
    .add({
      name: 'ground',
      static: true,
      position: { x: 0, y: -0.5, z: 0 },
      scale: { x: 2 * half + street, y: 1, z: 2 * half + street },
    })
    .setMesh(cube, ground, { castShadow: false });

  const buildings: Node[] = [];
  const lot = block / 3;
  for (let bx = 0; bx < blocks; bx++) {
    for (let bz = 0; bz < blocks; bz++) {
      const x0 = -half + bx * pitch + street / 2;
      const z0 = -half + bz * pitch + street / 2;
      city
        .add({
          name: 'sidewalk',
          static: true,
          position: { x: x0 + block / 2, y: 0.1, z: z0 + block / 2 },
          scale: { x: block + 4, y: 0.2, z: block + 4 },
        })
        .setMesh(cube, sidewalk, { castShadow: false });
      // Taller towards the center of the city.
      const center =
        1 - Math.hypot(x0 + block / 2, z0 + block / 2) / (half * Math.SQRT2);
      for (let i = 0; i < 9; i++) {
        const width = lot * (0.72 + random() * 0.22);
        const depth = lot * (0.72 + random() * 0.22);
        const height = 8 + random() ** 2 * 30 + center * center * 70;
        const building = city
          .add({
            name: 'building',
            static: true,
            occluder: true,
            position: {
              x: x0 + ((i % 3) + 0.5) * lot,
              y: height / 2,
              z: z0 + (Math.floor(i / 3) + 0.5) * lot,
            },
            scale: { x: width, y: height, z: depth },
          })
          .setMesh(cube, facades[Math.floor(random() * facades.length)]);
        buildings.push(building);
      }
    }
  }

  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.28, y: 0.3, z: 0.36 },
    diffuse: { x: 1.4, y: 1.3, z: 1.15 },
    specular: { x: 1, y: 0.95, z: 0.85 },
  });
  scene.root
    .add({ name: 'sun', rotation: axisAngle(0.82, 0.4, 0.41, -1.05) })
    .setLight(sun);

  const streets = Array.from(
    { length: blocks + 1 },
    (_, i) => -half + i * pitch
  );
  return { plan, half, streets, buildings, sun, cube };
}
