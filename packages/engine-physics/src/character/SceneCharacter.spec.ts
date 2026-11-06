import { Material, Mesh } from '@fdw/engine-core';
import { colorGraph } from '@fdw/engine-core/testing';
import { Obb } from '@fdw/engine-geometry';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { SceneCharacter } from './SceneCharacter';

// A unit cube around the origin: 8 corners, 12 triangles.
const cube = () => {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[i * 3] = i & 1 ? 0.5 : -0.5;
    positions[i * 3 + 1] = i & 2 ? 0.5 : -0.5;
    positions[i * 3 + 2] = i & 4 ? 0.5 : -0.5;
  }
  const faces = [
    [0, 1, 3, 2],
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [2, 3, 7, 6],
    [0, 2, 6, 4],
    [1, 5, 7, 3],
  ];
  const indices = new Uint16Array(
    faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]),
  );
  return new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
      ],
      vertexCount: 8,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [positions],
    indices,
  });
};

const material = new Material({ graph: colorGraph() });
const unit = cube();

// A box from min to max, a renderer of the scene.
const box = (
  scene: Scene,
  min: [number, number, number],
  max: [number, number, number],
) =>
  scene.root
    .add({
      position: {
        x: (min[0] + max[0]) / 2,
        y: (min[1] + max[1]) / 2,
        z: (min[2] + max[2]) / 2,
      },
      scale: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    })
    .setMesh(unit, material);

// A floor of 20 × 20 m, its top at 0.
const level = () => {
  const scene = new Scene();
  box(scene, [-10, -1, -10], [10, 0, 10]);
  return scene;
};

// The capsule of the tests: radius 0.3, 1.8 tall, its center 0.9 above
// its feet.
const feet = (character: SceneCharacter) => character.position.y - 0.9;

// Walks for `seconds` at `velocity` (m/s), falling with gravity.
const walk = (
  character: SceneCharacter,
  velocity: { x: number; z: number },
  seconds: number,
) => {
  const dt = 1 / 60;
  let vy = 0;
  for (let t = 0; t < seconds; t += dt) {
    vy = character.grounded ? -1 : vy - 9.81 * dt;
    character.move({ x: velocity.x * dt, y: vy * dt, z: velocity.z * dt });
  }
};

describe('SceneCharacter', () => {
  it('falls onto the floor and stands there', () => {
    const scene = level();
    const character = new SceneCharacter(scene, { position: { y: 3 } });
    expect(character.grounded).toBe(false);
    walk(character, { x: 0, z: 0 }, 2);
    expect(character.grounded).toBe(true);
    expect(feet(character)).toBeCloseTo(0.02, 2);
  });

  it('slides along a wall', () => {
    const scene = level();
    // A wall across z = 2.
    const wall = box(scene, [-10, 0, 2], [10, 3, 2.5]);
    const character = new SceneCharacter(scene, { position: { y: 0.92 } });
    walk(character, { x: 0, z: 0 }, 0.1);
    // Diagonally into the wall: stopped along z, still going along x.
    const move = character.move({ x: 0.5, y: -0.01, z: 3 });
    expect(character.position.z).toBeCloseTo(2 - 0.32, 2);
    expect(character.position.x).toBeCloseTo(0.5, 2);
    expect(move.collisions).toContain(wall.entity);
    expect(move.grounded).toBe(true);
  });

  it('climbs a step, not a ledge', () => {
    const scene = level();
    box(scene, [1, 0, -10], [10, 0.25, 10]);
    box(scene, [-10, 0, 1], [10, 1, 10]);
    const character = new SceneCharacter(scene, { position: { y: 0.92 } });
    walk(character, { x: 0, z: 0 }, 0.1);
    walk(character, { x: 2, z: 0 }, 1.5);
    expect(character.position.x).toBeGreaterThan(2);
    expect(feet(character)).toBeCloseTo(0.27, 1);
    // The ledge of 1 m along z: blocked.
    walk(character, { x: 0, z: 2 }, 1.5);
    expect(character.position.z).toBeCloseTo(1 - 0.32, 2);
  });

  it('walks up a gentle slope and stays on it, not a steep one', () => {
    const scene = level();
    const ramp = (degrees: number, z: number) => {
      const a = (degrees * Math.PI) / 180;
      const volume = new Obb(
        [1, 0, z],
        [4, 0.5, 1],
        [
          [Math.cos(a), Math.sin(a), 0],
          [-Math.sin(a), Math.cos(a), 0],
          [0, 0, 1],
        ],
      );
      // The renderer of the ramp: its volume replaces its bounds.
      scene.root
        .add({ position: { x: 1, z }, scale: { x: 8, y: 8, z: 2 } })
        .setMesh(unit, material, { volume });
    };
    ramp(20, 0);
    ramp(60, 5);
    const gentle = new SceneCharacter(scene, { position: { x: -2, y: 0.92 } });
    walk(gentle, { x: 0, z: 0 }, 0.1);
    walk(gentle, { x: 2, z: 0 }, 1.5);
    expect(gentle.position.x).toBeGreaterThan(0.5);
    expect(feet(gentle)).toBeGreaterThan(0.3);
    // Standing on it: no sliding down.
    const x = gentle.position.x;
    walk(gentle, { x: 0, z: 0 }, 1);
    expect(gentle.position.x).toBeCloseTo(x, 2);
    expect(gentle.grounded).toBe(true);

    const steep = new SceneCharacter(scene, {
      position: { x: -2, y: 0.92, z: 5 },
    });
    walk(steep, { x: 0, z: 0 }, 0.1);
    walk(steep, { x: 2, z: 0 }, 1.5);
    expect(feet(steep)).toBeLessThan(0.5);
  });

  it('stays on the ground down the steps, falls off a cliff', () => {
    const scene = new Scene();
    box(scene, [-10, -1, -10], [0, 0, 10]);
    box(scene, [0, -1.2, -10], [3, -0.2, 10]);
    box(scene, [3, -11, -10], [10, -10, 10]);
    const character = new SceneCharacter(scene, {
      position: { x: -1, y: 0.92 },
    });
    walk(character, { x: 0, z: 0 }, 0.1);
    character.move({ x: 1.5, y: 0, z: 0 });
    expect(character.grounded).toBe(true);
    expect(feet(character)).toBeCloseTo(-0.18, 1);
    character.move({ x: 3.5, y: 0, z: 0 });
    expect(character.grounded).toBe(false);
  });

  it('stands on a ground function, ignores what it is told to', () => {
    const scene = new Scene();
    const crate = box(scene, [-1, 0, 2], [1, 2, 3]);
    const character = new SceneCharacter(scene, {
      position: { y: 5 },
      ground: (x) => 0.1 * x,
      ignore: (entity) => entity === crate.entity,
    });
    walk(character, { x: 0, z: 0 }, 2);
    expect(feet(character)).toBeCloseTo(0.02, 2);
    walk(character, { x: 2, z: 2 }, 1);
    expect(character.position.z).toBeGreaterThan(2);
    expect(feet(character)).toBeCloseTo(0.1 * character.position.x + 0.02, 1);
    character.teleport({ x: 0, y: 10 });
    expect(character.position).toEqual({
      x: 0,
      y: 10,
      z: character.position.z,
    });
    expect(character.grounded).toBe(false);
  });

  it('bumps its head on a ceiling', () => {
    const scene = level();
    box(scene, [-10, 2.5, -10], [10, 3, 10]);
    const character = new SceneCharacter(scene, { position: { y: 0.92 } });
    walk(character, { x: 0, z: 0 }, 0.1);
    character.move({ x: 0, y: 1, z: 0 });
    expect(character.position.y + 0.9).toBeCloseTo(2.5 - 0.02, 2);
  });
});
