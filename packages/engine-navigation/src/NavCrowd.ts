// Reciprocal avoidance between agents: optimal reciprocal collision
// avoidance (ORCA, van den Berg, Guy, Lin and Manocha, 2011), as the RVO2
// library does it, on the ground: x and z. Each agent takes half of the
// effort to avoid each other; the velocities allowed by each neighbor are
// a half-plane, and the velocity kept the closest to the one wanted in all
// of them (a linear program in 2D, then the least bad when none fits).

/** Options of a {@link NavCrowd}. */
export interface NavCrowdOptions {
  /**
   * How far ahead the agents avoid each other, in seconds: longer avoids
   * earlier, and constrains more. Default 1.5.
   */
  readonly timeHorizon?: number;
  /** The neighbors seen within this distance, in meters. Default 6. */
  readonly neighborDistance?: number;
  /** At most this many neighbors, the closest. Default 8. */
  readonly maxNeighbors?: number;
}

/** Options of an agent of a {@link NavCrowd}. */
export interface CrowdAgentOptions {
  readonly radius: number;
  /** Meters per second. */
  readonly maxSpeed: number;
  readonly position?: { readonly x: number; readonly z: number };
  /** Whether it makes way for the others. Default true. */
  readonly avoids?: boolean;
  readonly userData?: unknown;
}

/** An agent of a {@link NavCrowd}: where it is, where it would go. */
export class CrowdAgent {
  /** On the ground: x, z. */
  readonly position = { x: 0, z: 0 };
  /** The velocity it would like (a path followed), m/s. */
  readonly preferred = { x: 0, z: 0 };
  /**
   * Its velocity: the one the crowd gave at its last update, unless the
   * agent says better (where the obstacles let it go).
   */
  readonly velocity = { x: 0, z: 0 };
  radius: number;
  maxSpeed: number;
  /**
   * Whether it makes way for the others; false, it goes its way, and the
   * others take the whole effort: a striker, a statue.
   */
  avoids: boolean;
  userData: unknown;
  /** @internal */
  readonly _next = { x: 0, z: 0 };

  /** @internal */
  constructor(options: CrowdAgentOptions) {
    this.radius = options.radius;
    this.maxSpeed = options.maxSpeed;
    this.avoids = options.avoids ?? true;
    this.userData = options.userData;
    if (options.position) {
      this.position.x = options.position.x;
      this.position.z = options.position.z;
    }
  }

  /** Puts it at a point of the ground. */
  moveTo(x: number, z: number): void {
    this.position.x = x;
    this.position.z = z;
  }

  /** The velocity it would like. */
  prefer(x: number, z: number): void {
    this.preferred.x = x;
    this.preferred.z = z;
  }
}

// A line: a point, and its direction; the velocities allowed on its left.
interface Line {
  px: number;
  pz: number;
  dx: number;
  dz: number;
}

const epsilon = 1e-5;
const det = (ax: number, az: number, bx: number, bz: number) =>
  ax * bz - az * bx;

/**
 * Agents that make way for each other: given where each is and the
 * velocity it would like (toward the next corner of its path), the
 * velocity it can take without running into the others for
 * `timeHorizon` seconds, as close as can be to the one it wanted. The
 * agents pass each other by a side, without the jostle of pushes.
 *
 * It moves nothing, and knows no walls: the paths keep off them, the
 * character controllers collide.
 *
 * @example
 * ```ts
 * const crowd = new NavCrowd();
 * const a = crowd.add({ radius: 0.4, maxSpeed: 3 });
 * // Each step, for each agent:
 * a.moveTo(feet.x, feet.z);
 * const step = agent.update(feet, dt); // a NavAgent on its path
 * a.prefer(step.x / dt, step.z / dt);
 * // Then, for all:
 * crowd.update(dt);
 * controller.move({ x: a.velocity.x * dt, y: -fall * dt, z: a.velocity.z * dt });
 * ```
 */
export class NavCrowd {
  timeHorizon: number;
  neighborDistance: number;
  maxNeighbors: number;
  private readonly _agents = new Set<CrowdAgent>();
  // The scratch of an update.
  private readonly _lines: Line[] = [];
  private readonly _projected: Line[] = [];
  private readonly _neighbors: { agent: CrowdAgent; distance: number }[] = [];

  constructor(options: NavCrowdOptions = {}) {
    this.timeHorizon = options.timeHorizon ?? 1.5;
    this.neighborDistance = options.neighborDistance ?? 6;
    this.maxNeighbors = options.maxNeighbors ?? 8;
  }

  /** The agents. */
  get agents(): Iterable<CrowdAgent> {
    return this._agents;
  }

  get size(): number {
    return this._agents.size;
  }

  add(options: CrowdAgentOptions): CrowdAgent {
    const agent = new CrowdAgent(options);
    this._agents.add(agent);
    return agent;
  }

  remove(agent: CrowdAgent): void {
    this._agents.delete(agent);
  }

  /**
   * The velocities of a step of `dt` seconds: each agent's, from where
   * they are and the velocities they had and would like, written into its
   * `velocity`.
   */
  update(dt: number): void {
    for (const agent of this._agents) this.solve(agent, dt);
    for (const agent of this._agents) {
      agent.velocity.x = agent._next.x;
      agent.velocity.z = agent._next.z;
    }
  }

  // The new velocity of an agent, into its _next.
  private solve(agent: CrowdAgent, dt: number): void {
    const out = agent._next;
    const max = agent.maxSpeed;
    let px = agent.preferred.x;
    let pz = agent.preferred.z;
    const speed = Math.hypot(px, pz);
    if (speed > max) {
      px *= max / speed;
      pz *= max / speed;
    }
    if (!agent.avoids) {
      out.x = px;
      out.z = pz;
      return;
    }
    // The closest neighbors.
    const neighbors = this._neighbors;
    neighbors.length = 0;
    const range2 = this.neighborDistance * this.neighborDistance;
    for (const other of this._agents) {
      if (other === agent) continue;
      const ox = other.position.x - agent.position.x;
      const oz = other.position.z - agent.position.z;
      const d2 = ox * ox + oz * oz;
      if (d2 < range2) neighbors.push({ agent: other, distance: d2 });
    }
    neighbors.sort((a, b) => a.distance - b.distance);
    if (neighbors.length > this.maxNeighbors) {
      neighbors.length = this.maxNeighbors;
    }

    // A half-plane of velocities per neighbor.
    const lines = this._lines;
    lines.length = 0;
    const inverseHorizon = 1 / this.timeHorizon;
    const vx = agent.velocity.x;
    const vz = agent.velocity.z;
    for (const { agent: other } of neighbors) {
      const rx = other.position.x - agent.position.x;
      const rz = other.position.z - agent.position.z;
      const relativeX = vx - other.velocity.x;
      const relativeZ = vz - other.velocity.z;
      const distance2 = rx * rx + rz * rz;
      const radius = agent.radius + other.radius;
      const radius2 = radius * radius;
      const line: Line = { px: 0, pz: 0, dx: 0, dz: 0 };
      let ux: number;
      let uz: number;
      if (distance2 > radius2) {
        // Apart: the velocity obstacle, a cone cut by a disk.
        const wx = relativeX - inverseHorizon * rx;
        const wz = relativeZ - inverseHorizon * rz;
        const w2 = wx * wx + wz * wz;
        const dot = wx * rx + wz * rz;
        if (dot < 0 && dot * dot > radius2 * w2) {
          // Out through the disk.
          const w = Math.sqrt(w2);
          const nx = wx / w;
          const nz = wz / w;
          line.dx = nz;
          line.dz = -nx;
          ux = (radius * inverseHorizon - w) * nx;
          uz = (radius * inverseHorizon - w) * nz;
        } else {
          // Out through a leg of the cone.
          const leg = Math.sqrt(distance2 - radius2);
          if (det(rx, rz, wx, wz) > 0) {
            line.dx = (rx * leg - rz * radius) / distance2;
            line.dz = (rx * radius + rz * leg) / distance2;
          } else {
            line.dx = -(rx * leg + rz * radius) / distance2;
            line.dz = -(-rx * radius + rz * leg) / distance2;
          }
          const along = relativeX * line.dx + relativeZ * line.dz;
          ux = along * line.dx - relativeX;
          uz = along * line.dz - relativeZ;
        }
      } else {
        // Already overlapping: apart within the step.
        const inverseStep = 1 / Math.max(dt, 1e-6);
        const wx = relativeX - inverseStep * rx;
        const wz = relativeZ - inverseStep * rz;
        const w = Math.hypot(wx, wz) || 1e-9;
        const nx = wx / w;
        const nz = wz / w;
        line.dx = nz;
        line.dz = -nx;
        ux = (radius * inverseStep - w) * nx;
        uz = (radius * inverseStep - w) * nz;
      }
      // Half of the effort each; all of it facing one that does not avoid.
      const share = other.avoids ? 0.5 : 1;
      line.px = vx + share * ux;
      line.pz = vz + share * uz;
      lines.push(line);
    }

    const failed = this.program2(lines, max, px, pz, false, out);
    if (failed < lines.length) this.program3(lines, failed, max, out);
  }

  // The velocity on the line `index`, within the speed and the lines
  // before it, closest to (px, pz) (or furthest along it, `direction`).
  private program1(
    lines: readonly Line[],
    index: number,
    max: number,
    px: number,
    pz: number,
    direction: boolean,
    out: { x: number; z: number },
  ): boolean {
    const line = lines[index];
    const dot = line.px * line.dx + line.pz * line.dz;
    const discriminant =
      dot * dot + max * max - (line.px * line.px + line.pz * line.pz);
    if (discriminant < 0) return false;
    const root = Math.sqrt(discriminant);
    let left = -dot - root;
    let right = -dot + root;
    for (let i = 0; i < index; i++) {
      const other = lines[i];
      const denominator = det(line.dx, line.dz, other.dx, other.dz);
      const numerator = det(
        other.dx,
        other.dz,
        line.px - other.px,
        line.pz - other.pz,
      );
      if (Math.abs(denominator) <= epsilon) {
        // Parallel: on the wrong side of it, or not limited.
        if (numerator < 0) return false;
        continue;
      }
      const t = numerator / denominator;
      if (denominator >= 0) right = Math.min(right, t);
      else left = Math.max(left, t);
      if (left > right) return false;
    }
    let t: number;
    if (direction) {
      t = px * line.dx + pz * line.dz > 0 ? right : left;
    } else {
      t = line.dx * (px - line.px) + line.dz * (pz - line.pz);
      t = Math.min(Math.max(t, left), right);
    }
    out.x = line.px + t * line.dx;
    out.z = line.pz + t * line.dz;
    return true;
  }

  // The velocity within the speed and every line, closest to (px, pz);
  // the index of the first line it cannot satisfy, or their count.
  private program2(
    lines: readonly Line[],
    max: number,
    px: number,
    pz: number,
    direction: boolean,
    out: { x: number; z: number },
  ): number {
    if (direction) {
      out.x = px * max;
      out.z = pz * max;
    } else if (px * px + pz * pz > max * max) {
      const length = Math.hypot(px, pz);
      out.x = (px / length) * max;
      out.z = (pz / length) * max;
    } else {
      out.x = px;
      out.z = pz;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (det(line.dx, line.dz, line.px - out.x, line.pz - out.z) > 0) {
        const x = out.x;
        const z = out.z;
        if (!this.program1(lines, i, max, px, pz, direction, out)) {
          out.x = x;
          out.z = z;
          return i;
        }
      }
    }
    return lines.length;
  }

  // No velocity satisfies them all: the one that breaks the worst of them
  // the least.
  private program3(
    lines: readonly Line[],
    begin: number,
    max: number,
    out: { x: number; z: number },
  ): void {
    let distance = 0;
    const projected = this._projected;
    for (let i = begin; i < lines.length; i++) {
      const line = lines[i];
      if (det(line.dx, line.dz, line.px - out.x, line.pz - out.z) <= distance) {
        continue;
      }
      projected.length = 0;
      for (let j = 0; j < i; j++) {
        const other = lines[j];
        const p: Line = { px: 0, pz: 0, dx: 0, dz: 0 };
        const determinant = det(line.dx, line.dz, other.dx, other.dz);
        if (Math.abs(determinant) <= epsilon) {
          // Parallel, the same way: no constraint more.
          if (line.dx * other.dx + line.dz * other.dz > 0) continue;
          p.px = 0.5 * (line.px + other.px);
          p.pz = 0.5 * (line.pz + other.pz);
        } else {
          const t =
            det(other.dx, other.dz, line.px - other.px, line.pz - other.pz) /
            determinant;
          p.px = line.px + t * line.dx;
          p.pz = line.pz + t * line.dz;
        }
        const dx = other.dx - line.dx;
        const dz = other.dz - line.dz;
        const length = Math.hypot(dx, dz) || 1;
        p.dx = dx / length;
        p.dz = dz / length;
        projected.push(p);
      }
      const x = out.x;
      const z = out.z;
      if (
        this.program2(projected, max, -line.dz, line.dx, true, out) <
        projected.length
      ) {
        out.x = x;
        out.z = z;
      }
      distance = det(line.dx, line.dz, line.px - out.x, line.pz - out.z);
    }
  }
}
