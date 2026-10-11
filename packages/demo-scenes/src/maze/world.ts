import { DirectionalLight, Material, Mesh } from '@fdw/engine-core';
import type { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '../geometry';
import { buildLevel, Level } from './level';
import { generateMaze } from './maze';

// The PBR material of the game: a color, and how rough it is.
export function surfaceMaterial(
  color: [number, number, number],
  roughness: number
): Material {
  const g = new GraphBuilder('surface');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  return new Material({ graph: g.build(), values: { color, roughness } });
}

/** The world of the game: the level, its meshes, and the sun. */
export interface MazeWorld {
  readonly level: Level;
  readonly cube: Mesh;
  readonly sphere: Mesh;
  readonly sun: DirectionalLight;
}

/**
 * Builds the maze of the game in a scene, with a sun casting shadows
 * (`sun: false` for the dark, where the sun stays off).
 */
export function createMazeWorld(
  scene: Scene,
  { seed = 7, sun: daylight = true }: { seed?: number; sun?: boolean } = {}
): MazeWorld {
  const cube = createCube();
  const sphere = createSphere(24, 12);
  const level = buildLevel(scene, generateMaze(48, 48, seed), {
    cube,
    floor: surfaceMaterial([0.45, 0.42, 0.38], 0.9),
    wall: surfaceMaterial([0.62, 0.6, 0.66], 0.7),
  });
  // The sun: a node turned 70° down from the horizon (its -z axis is the
  // direction of the light), and a little to the side.
  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.2, y: 0.2, z: 0.24 },
    diffuse: { x: 1.3, y: 1.2, z: 1.05 },
    specular: { x: 1.3, y: 1.2, z: 1.05 },
  });
  scene.root
    .add({
      name: 'sun',
      rotation: axisAngle(0.95, 0, 0.31, -1.2),
      visible: daylight,
    })
    .setLight(sun);
  return { level, cube, sphere, sun };
}
