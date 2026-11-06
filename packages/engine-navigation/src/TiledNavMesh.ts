import { Aabb, type Volume } from '@fdw/engine-geometry';
import { NavMesh } from './NavMesh';
import {
  assemble,
  bounded,
  buildRegion,
  type Bounded,
  type RegionMesh,
  type Settings,
  settingsOf,
  type VoxelOptions,
} from './voxels';

/** Options of a {@link TiledNavMesh}. */
export interface TiledNavMeshOptions extends VoxelOptions {
  /** The side of a tile, in cells. Default 64. */
  readonly tileCells?: number;
}

/** An obstacle placed on a {@link TiledNavMesh}: where agents cannot go. */
export interface NavObstacle {
  /** Its volume, in the world, as last placed. */
  readonly volume: Volume;
}

interface Obstacle extends NavObstacle {
  volume: Volume;
  box: Aabb;
}

/**
 * A navigation mesh built by tiles, to change while the game runs: the
 * obstacles placed and moved carve the floor under them, the tiles they
 * touch are built again at the next {@link update}, the others kept. A new
 * {@link NavMesh} then, its polygons the rectangles of every tile, linked
 * across their sides.
 *
 * Each tile is built from the solids of the tile and of a margin around
 * it (the radius of the agents): the floors at its sides are eroded as
 * in a mesh built at once.
 *
 * @example
 * ```ts
 * const tiles = new TiledNavMesh({ bounds, volumes, agentRadius: 0.4 });
 * const crate = tiles.addObstacle(new Aabb([2, 0, 2], [3, 1, 3]));
 * // Once a step, or when it suits:
 * if (tiles.update()) agent.navMesh = tiles.navMesh;
 * ```
 */
export class TiledNavMesh {
  /** The side of a tile, in cells. */
  readonly tileCells: number;
  /** The tiles along x and z. */
  readonly tilesX: number;
  readonly tilesZ: number;
  private readonly _settings: Settings;
  private readonly _pad: number;
  private readonly _regions: (RegionMesh | undefined)[];
  private readonly _dirty = new Set<number>();
  private readonly _obstacles = new Set<Obstacle>();
  private _navMesh: NavMesh;
  private _version = 0;

  constructor(readonly options: TiledNavMeshOptions) {
    this._settings = settingsOf(options);
    const s = this._settings;
    this.tileCells = Math.max(4, Math.round(options.tileCells ?? 64));
    this.tilesX = Math.ceil(s.columnsX / this.tileCells);
    this.tilesZ = Math.ceil(s.columnsZ / this.tileCells);
    // Enough cells around a tile for the erosion of its sides.
    this._pad = Math.ceil(s.radius / s.cell) + 2;
    this._regions = new Array(this.tilesX * this.tilesZ).fill(undefined);
    for (let i = 0; i < this._regions.length; i++) this._dirty.add(i);
    this._navMesh = new NavMesh({ vertices: [], polygons: [] });
    this.update();
  }

  /** The mesh, as of the last {@link update}. */
  get navMesh(): NavMesh {
    return this._navMesh;
  }

  /** Counts the meshes made: one more at each update that changed it. */
  get version(): number {
    return this._version;
  }

  /** How many tiles are to build again. */
  get pending(): number {
    return this._dirty.size;
  }

  /** The obstacles placed. */
  get obstacles(): Iterable<NavObstacle> {
    return this._obstacles;
  }

  /** Places an obstacle: no floor in its volume, at the next update. */
  addObstacle(volume: Volume): NavObstacle {
    const obstacle: Obstacle = { volume, box: volume.bounds(new Aabb()) };
    this._obstacles.add(obstacle);
    this.invalidate(obstacle.box);
    return obstacle;
  }

  /** Moves an obstacle to a new volume. */
  moveObstacle(obstacle: NavObstacle, volume: Volume): void {
    const o = obstacle as Obstacle;
    if (!this._obstacles.has(o)) {
      throw new Error('The obstacle is not on this navigation mesh');
    }
    this.invalidate(o.box);
    o.volume = volume;
    o.box = volume.bounds(new Aabb());
    this.invalidate(o.box);
  }

  /** Takes an obstacle away: the floor back at the next update. */
  removeObstacle(obstacle: NavObstacle): void {
    const o = obstacle as Obstacle;
    if (this._obstacles.delete(o)) {
      this.invalidate(o.box);
    }
  }

  /**
   * Builds the tiles touching a box again at the next update: the volumes
   * changed there (`options.volumes` is read again).
   */
  invalidate(box: Aabb): void {
    const s = this._settings;
    // The floors within the radius of the agents, and the slopes of their
    // neighbors, change too.
    const margin = s.radius + 2 * s.cell;
    const tile = (value: number, min: number) =>
      Math.floor((value - min) / s.cell / this.tileCells);
    const x0 = Math.max(0, tile(box.min[0] - margin, s.minX));
    const z0 = Math.max(0, tile(box.min[2] - margin, s.minZ));
    const x1 = Math.min(this.tilesX - 1, tile(box.max[0] + margin, s.minX));
    const z1 = Math.min(this.tilesZ - 1, tile(box.max[2] + margin, s.minZ));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) this._dirty.add(z * this.tilesX + x);
    }
  }

  /**
   * Builds the tiles changed, at most `maxTiles` (the others at the next
   * calls), and makes the new mesh. Returns whether it changed.
   */
  update(maxTiles = Infinity): boolean {
    if (this._dirty.size === 0) return false;
    const s = this._settings;
    const volumes = bounded(this.options.volumes);
    const obstacles: Bounded[] = [...this._obstacles].map((o) => [
      o.volume,
      o.box,
    ]);
    let built = 0;
    for (const index of [...this._dirty]) {
      if (built >= maxTiles) break;
      const tx = index % this.tilesX;
      const tz = Math.floor(index / this.tilesX);
      const own = {
        x0: tx * this.tileCells,
        z0: tz * this.tileCells,
        x1: Math.min(s.columnsX, (tx + 1) * this.tileCells),
        z1: Math.min(s.columnsZ, (tz + 1) * this.tileCells),
      };
      this._regions[index] = buildRegion(s, own, this._pad, volumes, obstacles);
      this._dirty.delete(index);
      built++;
    }
    this._navMesh = new NavMesh(
      assemble(
        s,
        this._regions.filter((region) => region !== undefined),
      ),
    );
    this._version++;
    return true;
  }
}
