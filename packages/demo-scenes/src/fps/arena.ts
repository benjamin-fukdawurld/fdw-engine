import { DirectionalLight, Material, Mesh, PointLight } from '@fdw/engine-core';
import type { ComponentStore, Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '../geometry';
import { seededRandom } from '../maze/maze';
import { surfaceMaterial } from '../maze/world';

// A material without lighting: lamps, eyes, sparks, the crosshair.
export function glowMaterial(color: [number, number, number]): Material {
  const g = new GraphBuilder('glow');
  g.surface({ baseColor: g.uniform('color', BuiltinTypes.vec3f) });
  return new Material({ graph: g.build(), values: { color } });
}

/** The arena of the game: its meshes, what blocks, where drones appear. */
export interface Arena {
  readonly cube: Mesh;
  readonly sphere: Mesh;
  /** The entities the player and the drones cannot go through. */
  readonly Solid: ComponentStore;
  /** Half the size of the arena, centered on the origin. */
  readonly half: number;
  /** Where the drones come in: the gates in the walls. */
  readonly gates: readonly { readonly x: number; readonly z: number }[];
}

/**
 * Builds the arena: a tiled floor, walls around it, pillars and crates for
 * cover, lamps at the corners, a low sun casting long shadows. Every node
 * of the level is static: indexed once, never moved.
 */
export function buildArena(scene: Scene, { seed = 3 } = {}): Arena {
  const cube = createCube();
  const sphere = createSphere(24, 12);
  const Solid = scene.world.defineComponent('solid', {});
  const half = 20;
  const level = scene.root.add({ name: 'arena', static: true });

  // The floor: tiles of two shades, 2 m wide.
  const tiles = [
    surfaceMaterial([0.32, 0.33, 0.36], 0.85),
    surfaceMaterial([0.38, 0.39, 0.42], 0.75),
  ];
  const tile = 2;
  for (let i = 0; i < (2 * half) / tile; i++) {
    for (let j = 0; j < (2 * half) / tile; j++) {
      level
        .add({
          position: {
            x: -half + (i + 0.5) * tile,
            y: -0.05,
            z: -half + (j + 0.5) * tile,
          },
          scale: { x: tile, y: 0.1, z: tile },
          static: true,
        })
        .setMesh(cube, tiles[(i + j) % 2], { castShadow: false });
    }
  }

  const solid = (
    material: Material,
    position: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    name: string
  ) =>
    level
      .add({ name, position, scale, static: true, occluder: true })
      .setMesh(cube, material)
      .attach(Solid);

  // The walls, 4 m high, a gate of 3 m in the middle of each.
  const wall = surfaceMaterial([0.55, 0.5, 0.46], 0.8);
  const height = 4;
  const gate = 3;
  const length = half - gate / 2;
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      const along = end * (gate / 2 + length / 2);
      solid(
        wall,
        { x: along, y: height / 2, z: side * (half + 0.5) },
        { x: length, y: height, z: 1 },
        'wall'
      );
      solid(
        wall,
        { x: side * (half + 0.5), y: height / 2, z: along },
        { x: 1, y: height, z: length },
        'wall'
      );
    }
  }
  // Behind each gate, a dark recess: the drones come out of it.
  const recess = surfaceMaterial([0.08, 0.08, 0.1], 0.9);
  const gates = [
    { x: 0, z: -half - 1 },
    { x: 0, z: half + 1 },
    { x: -half - 1, z: 0 },
    { x: half + 1, z: 0 },
  ];
  for (const { x, z } of gates) {
    const alongX = x === 0;
    solid(
      recess,
      { x: x * 1.1, y: height / 2, z: z * 1.1 },
      alongX
        ? { x: gate + 2, y: height, z: 1 }
        : { x: 1, y: height, z: gate + 2 },
      'recess'
    );
  }

  // Pillars in a ring, crates scattered: cover.
  const pillar = surfaceMaterial([0.62, 0.6, 0.58], 0.6);
  for (let k = 0; k < 8; k++) {
    const angle = (k / 8) * Math.PI * 2 + Math.PI / 8;
    solid(
      pillar,
      { x: Math.cos(angle) * 9, y: height / 2, z: Math.sin(angle) * 9 },
      { x: 1.2, y: height, z: 1.2 },
      'pillar'
    );
  }
  const crates = [
    surfaceMaterial([0.55, 0.38, 0.2], 0.7),
    surfaceMaterial([0.3, 0.42, 0.3], 0.7),
  ];
  const random = seededRandom(seed);
  for (let k = 0; k < 20; k++) {
    // Away from the center, off the four lanes from the gates.
    const angle = random() * Math.PI * 2;
    const distance = 4 + random() * 13;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const size = random() < 0.3 ? 2 : 1;
    if (Math.min(Math.abs(x), Math.abs(z)) < 2 + size / 2) {
      continue;
    }
    solid(
      crates[k % 2],
      { x, y: size / 2, z },
      { x: size, y: size, z: size },
      'crate'
    );
  }

  // Lamps on posts at the corners: point lights, and their glowing bulbs.
  const post = surfaceMaterial([0.15, 0.15, 0.17], 0.4);
  const bulb = glowMaterial([1, 0.75, 0.4]);
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const at = { x: x * (half - 2), z: z * (half - 2) };
    solid(post, { ...at, y: 1.5 }, { x: 0.3, y: 3, z: 0.3 }, 'post');
    level
      .add({
        name: 'bulb',
        position: { ...at, y: 3.2 },
        scale: { x: 0.5, y: 0.5, z: 0.5 },
        static: true,
      })
      .setMesh(sphere, bulb, { castShadow: false });
    level.add({ name: 'lamp', position: { ...at, y: 3.2 } }).setLight(
      new PointLight({
        ambient: { x: 0, y: 0, z: 0 },
        diffuse: { x: 2.4, y: 1.7, z: 0.9 },
        specular: { x: 0.6, y: 0.45, z: 0.25 },
        quadraticAttenuation: 0.06,
      })
    );
  }

  // A low sun at the end of the day: long shadows across the floor.
  scene.root
    .add({ name: 'sun', rotation: axisAngle(0.9, 0.42, 0, -0.55) })
    .setLight(
      new DirectionalLight({
        castShadow: true,
        ambient: { x: 0.16, y: 0.17, z: 0.24 },
        diffuse: { x: 1.4, y: 1.05, z: 0.75 },
        specular: { x: 1, y: 0.8, z: 0.6 },
      })
    );
  return { cube, sphere, Solid, half, gates };
}
