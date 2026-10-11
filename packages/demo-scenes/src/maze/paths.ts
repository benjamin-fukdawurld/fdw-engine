import { Maze, Wall } from './maze';

// The neighbors of a cell, and the wall between them.
const sides = [
  { dx: 0, dz: -1, wall: Wall.North },
  { dx: 1, dz: 0, wall: Wall.East },
  { dx: 0, dz: 1, wall: Wall.South },
  { dx: -1, dz: 0, wall: Wall.West },
];

/** The cells next to a cell with no wall between them. */
export function openNeighbors(maze: Maze, cell: number): number[] {
  const walls = maze.cells[cell];
  const neighbors: number[] = [];
  for (const { dx, dz, wall } of sides) {
    if (!(walls & wall)) {
      neighbors.push(cell + dz * maze.width + dx);
    }
  }
  return neighbors;
}

/**
 * The number of steps from a cell to every other, walking through the
 * maze (a breadth-first walk): -1 where it cannot go.
 */
export function distancesFrom(maze: Maze, from: number): Int32Array {
  const distances = new Int32Array(maze.cells.length).fill(-1);
  const queue = new Int32Array(maze.cells.length);
  let head = 0;
  let tail = 0;
  distances[from] = 0;
  queue[tail++] = from;
  while (head < tail) {
    const cell = queue[head++];
    for (const next of openNeighbors(maze, cell)) {
      if (distances[next] < 0) {
        distances[next] = distances[cell] + 1;
        queue[tail++] = next;
      }
    }
  }
  return distances;
}

/**
 * The first step from a cell towards another, through the maze: the
 * neighbor closest to the goal. The cell itself when it is the goal.
 */
export function nextStep(maze: Maze, from: number, to: number): number {
  if (from === to) {
    return from;
  }
  const distances = distancesFrom(maze, to);
  let best = from;
  for (const next of openNeighbors(maze, from)) {
    if (
      distances[next] >= 0 &&
      (best === from || distances[next] < distances[best])
    ) {
      best = next;
    }
  }
  return best;
}
