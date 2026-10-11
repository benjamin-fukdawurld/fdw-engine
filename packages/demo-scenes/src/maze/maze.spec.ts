import { Camera, Material } from '@fdw/engine-core';
import { colorGraph } from '@fdw/engine-core/testing';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { createCube, createSphere } from '../geometry';
import { Aim, pointerOnPlane } from './aim';
import { mazeActions } from './controls';
import { resolveCircle } from './collisions';
import { EnemyState, MazeGame } from './game';
import { Exploration } from './exploration';
import { FixedStep } from './fixedStep';
import { Flashlight } from './flashlight';
import { Player } from './player';
import { buildLevel } from './level';
import { generateMaze, Maze, Wall } from './maze';
import { distancesFrom, nextStep, openNeighbors } from './paths';

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

// The actions of the game, driven by the test; and actions nobody drives.
const controls = () => {
  const source = new FakeInputSource();
  const input = new Input(source);
  return { source, input, actions: mazeActions(input) };
};
const idle = () => controls().actions;

describe('mazeActions', () => {
  it('binds the keys by position, and the gamepad', () => {
    const { source, input, actions } = controls();
    // The key at the place of W: Z on an AZERTY keyboard.
    source.keyDown('KeyW', 'z');
    source.keyDown('ShiftLeft', 'Shift');
    input.update();
    expect(actions.vector('move')).toEqual({ x: 0, y: 1 });
    expect(actions.button('run').down).toBe(true);
    source.keyUp('KeyW', 'z');
    source.keyUp('ShiftLeft', 'Shift');
    const pad = source.connectGamepad();
    source.setAxis(pad, 'leftX', 1);
    source.setButton(pad, 'rightTrigger', 1);
    source.setButton(pad, 'leftShoulder', 1);
    input.update();
    expect(actions.vector('move')).toEqual({ x: 1, y: 0 });
    expect(actions.button('flashlight').pressed).toBe(true);
    expect(actions.axis('turn')).toBe(1);
  });

  it('aims with the mouse or the right stick, the one used last', () => {
    const { source, input, actions } = controls();
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 90,
        aspect: 1,
        near: 0.1,
        far: 50,
      },
    });
    // A camera 10 units up, looking straight down (its -z is -y).
    const eye = {
      worldMatrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 10, 0, 1],
    };
    const aim = new Aim();
    const around = { x: 0, z: 0 };
    input.update();
    expect(aim.update(input, actions, eye, camera, around, 0)).toBeUndefined();
    // The pointer at the center: the point under the camera.
    source.sink?.pointerMove(0.5, 0.5);
    input.update();
    const point = aim.update(input, actions, eye, camera, around, 0);
    expect(point?.x).toBeCloseTo(0, 5);
    expect(point?.z).toBeCloseTo(0, 5);
    // The right stick pushed up: forward, -z when the camera has no yaw.
    const pad = source.connectGamepad();
    source.setAxis(pad, 'rightY', -1);
    input.update();
    const ahead = aim.update(input, actions, eye, camera, around, 0);
    expect(ahead?.x).toBeCloseTo(0, 5);
    expect(ahead?.z).toBeCloseTo(-3, 5);
    // Released: nothing aims, until the pointer moves again.
    source.setAxis(pad, 'rightY', 0);
    input.update();
    expect(aim.update(input, actions, eye, camera, around, 0)).toBeUndefined();
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
    const { source, input, actions } = controls();
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
    source.keyDown('KeyW');
    input.update();
    for (let i = 0; i < 120; i++) {
      player.update(1 / 60, actions, 0);
    }
    // Forward is -z: stopped by the wall, facing it.
    expect(player.position.z).toBeCloseTo(player.radius, 3);
    expect(player.heading).toBeCloseTo(0, 3);
  });
});

describe('pointerOnPlane', () => {
  it('finds the point of the ground under the pointer', () => {
    // A camera 10 above (2, ·, 3), looking straight down: its -z axis is
    // -y, its x axis x, its y axis -z.
    const world = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 2, 10, 3, 1];
    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 90,
        aspect: 2,
        near: 0.1,
        far: 100,
      },
    });
    expect(pointerOnPlane(world, camera, { x: 0.5, y: 0.5 })).toEqual({
      x: 2,
      z: 3,
    });
    // The right edge: tan(45°) × aspect × 10 to the right.
    const right = pointerOnPlane(world, camera, { x: 1, y: 0.5 });
    expect(right?.x).toBeCloseTo(22, 6);
    // The top edge: towards -z.
    const top = pointerOnPlane(world, camera, { x: 0.5, y: 0 });
    expect(top?.z).toBeCloseTo(-7, 6);
  });
});

// Two corridors of four cells along x, joined at their east end:
//   0 1 2 3
//   4 5 6 7   (3 and 7 open to each other)
const corridors = (): Maze => {
  const { North: N, East: E, South: S, West: W } = Wall;
  return {
    width: 4,
    height: 2,
    cells: new Uint8Array([
      N | S | W,
      N | S,
      N | S,
      N | E,
      N | S | W,
      N | S,
      N | S,
      S | E,
    ]),
  };
};

// A level in a scene, its walls solid.
const levelOf = (maze: Maze) => {
  const scene = new Scene();
  const material = new Material({ graph: colorGraph() });
  const cube = createCube();
  const level = buildLevel(scene, maze, {
    cube,
    floor: material,
    wall: material,
  });
  const Solid = scene.world.defineComponent('solid', {});
  for (const wall of level.walls.children) {
    wall.attach(Solid);
  }
  const player = new Player(scene, Solid, level.cellCenter(0, 0), {
    sphere: createSphere(8, 4),
    cube,
    body: material,
  });
  return { scene, level, Solid, player, cube, material };
};

describe('paths', () => {
  it('walks through the maze, not through its walls', () => {
    const maze = corridors();
    expect(openNeighbors(maze, 3)).toEqual([7, 2]);
    expect([...distancesFrom(maze, 0)]).toEqual([0, 1, 2, 3, 7, 6, 5, 4]);
    // From 0 to 4, the cell just below: all the way round.
    expect(nextStep(maze, 0, 4)).toBe(1);
    expect(nextStep(maze, 7, 4)).toBe(6);
    expect(nextStep(maze, 4, 4)).toBe(4);
  });
});

describe('FixedStep', () => {
  it('runs as many steps as the frames hold, at most a few', () => {
    const loop = new FixedStep(0.1, 3);
    let steps = 0;
    loop.advance(0.25, () => steps++);
    expect(steps).toBe(2);
    // The 0.05 left, and 0.05 more: one step.
    loop.advance(0.05, () => steps++);
    expect(steps).toBe(3);
    // A long pause: three steps, not ten.
    loop.advance(1, () => steps++);
    expect(steps).toBe(6);
  });
});

describe('Exploration', () => {
  it('discovers the cell walked through, and those open around it', () => {
    const { level } = levelOf(corridors());
    const exploration = new Exploration(level);
    const { x, z } = level.cellCenter(3, 0);
    exploration.walk({ x, z });
    expect([...exploration.discovered]).toEqual([0, 0, 1, 1, 0, 0, 0, 1]);
    expect(exploration.count).toBe(3);
    exploration.reset();
    expect(exploration.count).toBe(0);
  });

  it('discovers what the beam lights, not what a wall hides', () => {
    const { scene, level, Solid, player } = levelOf(corridors());
    const flashlight = new Flashlight(player.node);
    // Facing +x, along the first corridor.
    player.heading = -Math.PI / 2;
    player.update(0, idle(), 0);
    const exploration = new Exploration(level);
    exploration.light(scene, Solid, flashlight.beam);
    // 1 to 3 lit; 6 and 7 in the cone, behind the wall; 0 under the light.
    expect([...exploration.discovered]).toEqual([0, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe('MazeGame', () => {
  const setup = (options: { gems?: number; enemies?: number }) => {
    const parts = levelOf(generateMaze(12, 12, 4));
    const { scene, level, Solid, player, cube } = parts;
    const flashlight = new Flashlight(player.node);
    const exploration = new Exploration(level);
    const game = new MazeGame(
      scene,
      level,
      Solid,
      player,
      flashlight,
      exploration,
      { cube, sphere: createSphere(8, 4) },
      options
    );
    const centerOf = (cell: number) =>
      level.cellCenter(cell % level.maze.width, Math.floor(cell / 12));
    // Puts the player at the center of a cell.
    const goTo = (cell: number) => {
      const { x, z } = centerOf(cell);
      player.position.x = x;
      player.position.z = z;
      player.update(0, idle(), 0);
    };
    return { ...parts, flashlight, game, centerOf, goTo };
  };

  it('collects the gems, then opens the exit', () => {
    const { game, goTo } = setup({ gems: 3, enemies: 0 });
    expect(game.total).toBe(3);
    goTo(game.exitCell);
    game.update(1 / 60);
    // Locked while gems are left.
    expect(game.state).toBe('playing');
    for (const cell of game.gemCells()) {
      goTo(cell);
      game.update(1 / 60);
    }
    expect(game.collected).toBe(3);
    expect(game.gemCells()).toEqual([]);
    goTo(game.exitCell);
    game.update(1 / 60);
    expect(game.state).toBe('won');
    game.reset();
    expect(game.state).toBe('playing');
    expect(game.gemCells().length).toBe(3);
  });

  it('chases the player it sees, is dazzled by the beam, and catches', () => {
    const { game, goTo, flashlight, level, scene } = setup({
      gems: 0,
      enemies: 1,
    });
    const [enemy] = game.Enemy.entities;
    const { maze } = level;
    // The player two cells from the enemy, along an open path.
    const from = game.Enemy.from[enemy];
    const path = [from];
    while (path.length < 3) {
      const ahead = openNeighbors(maze, path[path.length - 1]).filter(
        (cell) => !path.includes(cell)
      );
      path.push(ahead[0] ?? path[path.length - 1]);
    }
    flashlight.on = false;
    goTo(path[1]);
    game.Enemy.to[enemy] = from;
    game.Enemy.progress[enemy] = 0;
    game.update(0.1);
    // Seen, a cell away in the dark: chased.
    expect(game.Enemy.state[enemy]).toBe(EnemyState.Chase);
    // The beam on it: dazzled, harmless.
    flashlight.on = true;
    const { x, z } = scene.node(enemy).transform.position;
    const player = game['_player'] as Player;
    player.heading = Math.atan2(
      -(x - player.position.x),
      -(z - player.position.z)
    );
    player.update(0, idle(), 0);
    game.update(0.1);
    expect(game.Enemy.state[enemy]).toBe(EnemyState.Dazzled);
    // Once the dazzle is over and the beam off, it catches the player.
    flashlight.on = false;
    for (let i = 0; i < 300 && game.state === 'playing'; i++) {
      game.update(1 / 60);
    }
    expect(game.state).toBe('lost');
  });
});
