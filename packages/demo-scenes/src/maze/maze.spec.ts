import { Material } from '@fdw/engine-core';
import { colorGraph } from '@fdw/engine-core/testing';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { createCube, createSphere } from '../geometry';
import { resolveCircle } from './collisions';
import { Input, normalizeKey } from './input';
import { Player } from './player';
import { buildLevel } from './level';
import { generateMaze, Wall } from './maze';

describe('generateMaze', () => {
  it('makes a perfect maze: every cell reachable, by a single path', () => {
    const maze = generateMaze(20, 12, 3);
    const { width, height, cells } = maze;
    // Walk from the first cell through the open walls.
    const seen = new Set([0]);
    const queue = [0];
    let openings = 0;
    while (queue.length > 0) {
      const cell = queue.shift() as number;
      const x = cell % width;
      const z = Math.floor(cell / width);
      for (const [bit, dx, dz] of [
        [Wall.North, 0, -1],
        [Wall.East, 1, 0],
        [Wall.South, 0, 1],
        [Wall.West, -1, 0],
      ]) {
        if (cells[cell] & bit) {
          continue;
        }
        openings++;
        const next = (z + dz) * width + x + dx;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size).toBe(width * height);
    // A tree: cells − 1 passages, each seen from both sides.
    expect(openings / 2).toBe(width * height - 1);
    // The border is closed.
    expect(cells[0] & Wall.North).toBeTruthy();
    expect(cells[width - 1] & Wall.East).toBeTruthy();
  });

  it('is the same for the same seed', () => {
    expect(generateMaze(10, 10, 5).cells).toEqual(
      generateMaze(10, 10, 5).cells
    );
    expect(generateMaze(10, 10, 5).cells).not.toEqual(
      generateMaze(10, 10, 6).cells
    );
  });
});

describe('buildLevel', () => {
  it('builds a static floor tile per cell, and each wall once', () => {
    const scene = new Scene();
    const maze = generateMaze(8, 6, 2);
    const material = new Material({ graph: colorGraph() });
    const level = buildLevel(scene, maze, {
      cube: createCube(),
      floor: material,
      wall: material,
    });
    expect(level.floor.children).toHaveLength(48);
    // Walls: the closed sides, those between two cells counted once.
    let sides = 0;
    maze.cells.forEach((walls) => {
      for (const bit of [Wall.North, Wall.East, Wall.South, Wall.West]) {
        sides += walls & bit ? 1 : 0;
      }
    });
    const border = 2 * (8 + 6);
    expect(level.walls.children).toHaveLength((sides - border) / 2 + border);
    expect(
      level.walls.children.every((wall) => wall.static && wall.occluder)
    ).toBe(true);
    expect(level.cellCenter(0, 0)).toEqual({ x: -7, z: -5 });
  });
});

describe('normalizeKey', () => {
  it('gives the same names in a browser and with SDL', () => {
    expect(
      ['w', 'W', 'ArrowUp', 'Up', ' ', 'Space', 'Left Shift', 'Shift'].map(
        normalizeKey
      )
    ).toEqual(['w', 'w', 'up', 'up', 'space', 'space', 'shift', 'shift']);
  });
});

describe('collisions', () => {
  // A wall along x, its face at z = 0, and the circle of a character.
  const setup = () => {
    const scene = new Scene();
    const Solid = scene.world.defineComponent('solid', {});
    const material = new Material({ graph: colorGraph() });
    scene.root
      .add({ position: { x: 0, y: 1, z: -0.5 }, scale: { x: 10, y: 2, z: 1 } })
      .setMesh(createCube(), material)
      .attach(Solid);
    // Not solid: a floor under the character.
    scene.root
      .add({ position: { y: -0.05 }, scale: { x: 10, y: 0.1, z: 10 } })
      .setMesh(createCube(), material);
    return { scene, Solid, material };
  };

  it('pushes a circle out of the walls, keeping the movement along them', () => {
    const { scene, Solid } = setup();
    const position = { x: 1, y: 0.4, z: 0.1 };
    expect(resolveCircle(scene, Solid, position, 0.35)).toBe(true);
    // Out along z only: it slides along the wall.
    expect(position.x).toBe(1);
    expect(position.z).toBeCloseTo(0.35, 6);
    // Far from it: nothing to do.
    const away = { x: 1, y: 0.4, z: 3 };
    expect(resolveCircle(scene, Solid, away, 0.35)).toBe(false);
  });

  it('stops a character walking into a wall', () => {
    const { scene, Solid, material } = setup();
    const keys = new EventTarget();
    const input = new Input(keys);
    const player = new Player(
      scene,
      Solid,
      { x: 0, z: 3 },
      {
        sphere: createSphere(8, 4),
        cube: createCube(),
        body: material,
      }
    );
    keys.dispatchEvent(Object.assign(new Event('keydown'), { key: 'w' }));
    for (let i = 0; i < 120; i++) {
      player.update(1 / 60, input, 0);
    }
    // Forward is -z: stopped by the wall, facing it.
    expect(player.position.z).toBeCloseTo(player.radius, 3);
    expect(player.heading).toBeCloseTo(0, 3);
  });
});
