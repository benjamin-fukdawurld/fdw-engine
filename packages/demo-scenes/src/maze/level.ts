import type { Material, Mesh } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import { Maze, Wall } from './maze';

export interface LevelOptions {
  // The size of a cell, and the height and thickness of the walls.
  readonly cellSize?: number;
  readonly wallHeight?: number;
  readonly wallThickness?: number;
}

/** A maze built in a scene. */
export interface Level {
  readonly maze: Maze;
  readonly cellSize: number;
  // The half size of the level, centered on the origin.
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly floor: Node;
  readonly walls: Node;
  /** The center of a cell, in the world. */
  cellCenter(x: number, z: number): { x: number; z: number };
}

/**
 * Builds a maze in a scene: a floor tile per cell, a wall per closed side.
 * Every node is static (indexed once), and the walls are occluders. `cube`
 * is a unit cube centered on the origin.
 */
export function buildLevel(
  scene: Scene,
  maze: Maze,
  { cube, floor, wall }: { cube: Mesh; floor: Material; wall: Material },
  { cellSize = 2, wallHeight = 2, wallThickness = 0.2 }: LevelOptions = {}
): Level {
  const halfWidth = (maze.width * cellSize) / 2;
  const halfDepth = (maze.height * cellSize) / 2;
  const cellCenter = (x: number, z: number) => ({
    x: (x + 0.5) * cellSize - halfWidth,
    z: (z + 0.5) * cellSize - halfDepth,
  });

  // Groups, for the hierarchy: nothing is drawn at their place.
  const floorGroup = scene.root.add({ name: 'floor', static: true });
  const wallGroup = scene.root.add({ name: 'walls', static: true });
  for (let z = 0; z < maze.height; z++) {
    for (let x = 0; x < maze.width; x++) {
      const { x: cx, z: cz } = cellCenter(x, z);
      floorGroup
        .add({
          position: { x: cx, y: -0.05, z: cz },
          scale: { x: cellSize, y: 0.1, z: cellSize },
          static: true,
        })
        .setMesh(cube, floor);
      // The north and west walls of each cell; the south and east ones on
      // the last row and column only: each wall once.
      const walls = maze.cells[z * maze.width + x];
      const sides = [
        { bit: Wall.North, dx: 0, dz: -0.5, along: 'x' },
        { bit: Wall.West, dx: -0.5, dz: 0, along: 'z' },
        ...(z === maze.height - 1
          ? [{ bit: Wall.South, dx: 0, dz: 0.5, along: 'x' }]
          : []),
        ...(x === maze.width - 1
          ? [{ bit: Wall.East, dx: 0.5, dz: 0, along: 'z' }]
          : []),
      ];
      for (const { bit, dx, dz, along } of sides) {
        if (!(walls & bit)) {
          continue;
        }
        const length = cellSize + wallThickness;
        wallGroup
          .add({
            position: {
              x: cx + dx * cellSize,
              y: wallHeight / 2,
              z: cz + dz * cellSize,
            },
            scale:
              along === 'x'
                ? { x: length, y: wallHeight, z: wallThickness }
                : { x: wallThickness, y: wallHeight, z: length },
            static: true,
            occluder: true,
          })
          .setMesh(cube, wall);
      }
    }
  }
  return {
    maze,
    cellSize,
    halfWidth,
    halfDepth,
    floor: floorGroup,
    walls: wallGroup,
    cellCenter,
  };
}
