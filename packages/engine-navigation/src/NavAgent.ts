import type { NavMesh, NavPoint, PathOptions } from './NavMesh';

/** Options of a {@link NavAgent}. */
export interface NavAgentOptions extends PathOptions {
  /** Meters per second. Default 3. */
  readonly speed?: number;
  /** How close to a corner counts as reached. Default 0.1. */
  readonly tolerance?: number;
  /**
   * Looks for a new path when the agent strays further than this from its
   * path (pushed, blocked). Default 1.
   */
  readonly maxDeviation?: number;
}

const distanceXZ = (a: NavPoint, b: NavPoint): number =>
  Math.hypot(b.x - a.x, b.z - a.z);

/**
 * An agent following paths on a navigation mesh: given its position each
 * step, the movement toward the next corner. It moves nothing itself: a
 * character controller does, against the obstacles, gravity added.
 *
 * @example
 * ```ts
 * const agent = new NavAgent(navMesh, { speed: 2.5 });
 * agent.setDestination(target);
 * // Each fixed step:
 * const step = agent.update(controller.position, dt);
 * controller.move({ x: step.x, y: -9.81 * dt * dt, z: step.z });
 * ```
 */
export class NavAgent {
  speed: number;
  readonly tolerance: number;
  readonly maxDeviation: number;
  private _path: NavPoint[] = [];
  private _corner = 0;
  private _destination?: NavPoint;
  private readonly _step: NavPoint = { x: 0, y: 0, z: 0 };

  constructor(
    readonly navMesh: NavMesh,
    private readonly _options: NavAgentOptions = {},
  ) {
    this.speed = _options.speed ?? 3;
    this.tolerance = _options.tolerance ?? 0.1;
    this.maxDeviation = _options.maxDeviation ?? 1;
  }

  /** The corners of the path followed, from where it started. */
  get path(): readonly NavPoint[] {
    return this._path;
  }

  /** The corner it walks to (an index of `path`). */
  get corner(): number {
    return this._corner;
  }

  /** Where it goes, until it gets there or stops. */
  get destination(): NavPoint | undefined {
    return this._destination;
  }

  /** Whether it has nowhere to go: arrived, stopped, or no path. */
  get idle(): boolean {
    return this._corner >= this._path.length;
  }

  /**
   * Goes to a point, from `from`; false when there is no path (then it
   * stops).
   */
  setDestination(from: NavPoint, to: NavPoint): boolean {
    this._destination = { ...to };
    return this.repath(from);
  }

  /** Stops where it is. */
  stop(): void {
    this._path = [];
    this._corner = 0;
    this._destination = undefined;
  }

  private repath(from: NavPoint): boolean {
    const destination = this._destination;
    const path = destination
      ? this.navMesh.findPath(from, destination, this._options)
      : undefined;
    if (!path) {
      this.stop();
      return false;
    }
    this._path = path;
    // The first corner is the start.
    this._corner = 1;
    return true;
  }

  /**
   * The movement of this step from `position` (meters, horizontal): toward
   * the next corner at `speed`, no further than the last one. Zero once
   * arrived. Written into `out` when given.
   */
  update(position: NavPoint, dt: number, out: NavPoint = this._step): NavPoint {
    out.x = out.y = out.z = 0;
    const path = this._path;
    if (this._corner >= path.length) {
      return out;
    }
    // Strayed from the segment it follows: a new path.
    const a = path[this._corner - 1];
    const b = path[this._corner];
    if (deviation(position, a, b) > this.maxDeviation) {
      if (!this.repath(position)) return out;
    }
    let budget = this.speed * dt;
    let x = position.x;
    let z = position.z;
    while (budget > 0 && this._corner < path.length) {
      const corner = path[this._corner];
      const d = Math.hypot(corner.x - x, corner.z - z);
      const last = this._corner === path.length - 1;
      if (d <= (last ? 1e-4 : this.tolerance)) {
        this._corner++;
        continue;
      }
      const t = Math.min(budget / d, 1);
      x += (corner.x - x) * t;
      z += (corner.z - z) * t;
      budget -= d * t;
      if (t >= 1) this._corner++;
    }
    out.x = x - position.x;
    out.z = z - position.z;
    if (this._corner >= path.length) {
      this._destination = undefined;
    }
    return out;
  }

  /** How far it still has to go along its path. */
  remaining(position: NavPoint): number {
    const path = this._path;
    if (this._corner >= path.length) return 0;
    let total = distanceXZ(position, path[this._corner]);
    for (let i = this._corner + 1; i < path.length; i++) {
      total += distanceXZ(path[i - 1], path[i]);
    }
    return total;
  }
}

// The distance from p to the segment a → b, from above.
function deviation(p: NavPoint, a: NavPoint, b: NavPoint): number {
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const l2 = ex * ex + ez * ez;
  const t =
    l2 > 0
      ? Math.min(Math.max(((p.x - a.x) * ex + (p.z - a.z) * ez) / l2, 0), 1)
      : 0;
  return Math.hypot(a.x + ex * t - p.x, a.z + ez * t - p.z);
}
