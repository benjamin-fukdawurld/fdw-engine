import type { SpotLight } from '@fdw/engine-core';
import type { ComponentStore, Scene } from '@fdw/engine-scene';
import type { Level } from './level';
import { openNeighbors } from './paths';
import { clearLine, inCone } from './sight';

/**
 * The cells of the maze the player has discovered: those walked through
 * and around, and those the flashlight lit. What the map shows.
 */
export class Exploration {
  /** 1 for each discovered cell, row by row (as Maze.cells). */
  readonly discovered: Uint8Array;
  /** The number of discovered cells. */
  count = 0;
  /** Changes with every discovery: the map redraws when it changes. */
  version = 0;

  constructor(readonly level: Level) {
    this.discovered = new Uint8Array(level.maze.width * level.maze.height);
  }

  /** Whether every cell was discovered. */
  get complete(): boolean {
    return this.count === this.discovered.length;
  }

  /** The cell at a point of the world, or -1 out of the maze. */
  cellAt(x: number, z: number): number {
    const { maze, cellSize, halfWidth, halfDepth } = this.level;
    const cx = Math.floor((x + halfWidth) / cellSize);
    const cz = Math.floor((z + halfDepth) / cellSize);
    if (cx < 0 || cz < 0 || cx >= maze.width || cz >= maze.height) {
      return -1;
    }
    return cz * maze.width + cx;
  }

  /** Discovers a cell: false if it already was. */
  discover(cell: number): boolean {
    if (cell < 0 || this.discovered[cell]) {
      return false;
    }
    this.discovered[cell] = 1;
    this.count++;
    this.version++;
    return true;
  }

  /** Back in the fog, for a new game. */
  reset(): void {
    this.discovered.fill(0);
    this.count = 0;
    this.version++;
  }

  /** Walking: the cell of the player, and those open around it. */
  walk(position: { readonly x: number; readonly z: number }): void {
    const cell = this.cellAt(position.x, position.z);
    if (cell < 0) {
      return;
    }
    this.discover(cell);
    for (const next of openNeighbors(this.level.maze, cell)) {
      this.discover(next);
    }
  }

  /**
   * Lighting: the cells not discovered yet whose center is in the cone of
   * a spot, closer than `reach`, and seen from it — no solid entity on the
   * line from the light to the center.
   */
  light(
    scene: Scene,
    solid: ComponentStore,
    spot: SpotLight,
    reach = 12
  ): void {
    const { maze, cellSize } = this.level;
    // The light where its node is now.
    scene.flush();
    const origin = spot.position;
    const center = this.cellAt(origin.x, origin.z);
    if (center < 0) {
      return;
    }
    // The cells of the square around the light, within the reach.
    const cells = Math.ceil(reach / cellSize);
    const cx = center % maze.width;
    const cz = Math.floor(center / maze.width);
    const zEnd = Math.min(maze.height - 1, cz + cells);
    const xEnd = Math.min(maze.width - 1, cx + cells);
    for (let z = Math.max(0, cz - cells); z <= zEnd; z++) {
      for (let x = Math.max(0, cx - cells); x <= xEnd; x++) {
        const cell = z * maze.width + x;
        if (this.discovered[cell]) {
          continue;
        }
        // The center of the cell, half a wall high.
        const { x: tx, z: tz } = this.level.cellCenter(x, z);
        const target = { x: tx, y: 0.5, z: tz };
        if (
          inCone(spot, target, reach) &&
          clearLine(scene, solid, origin, target)
        ) {
          this.discover(cell);
        }
      }
    }
  }
}
