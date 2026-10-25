import type { IQuat, IVec3 } from '@fdw/engine-backend';
import type { PhysicsBody } from '@fdw/engine-physics';
import type { Scheduler } from '@fdw/engine-scene';

/** Where the water is: an {@link Ocean}, or anything giving its height. */
export interface WaterHeight {
  /** The height of the water above a point of the world (x, z). */
  heightAt(x: number, z: number): number;
  /**
   * The velocity of the water at (x, z), in m/s (x and z): the current of
   * a river, the flow of a basin. The water drags the bodies against it;
   * still without it.
   */
  velocityAt?(x: number, z: number, out: { x: number; z: number }): void;
}

/** How a body floats (see {@link Buoyancy.add}). */
export interface FloaterOptions {
  /**
   * The points of the body, in its frame, where the water pushes: the
   * corners of a crate, points along a hull. Each stands for an equal
   * share of the volume.
   */
  readonly points: readonly IVec3[];
  /** The volume of the body, in m³: the water it pushes away when under. */
  readonly volume: number;
  /**
   * The height over which a point goes from dry to all wet, in meters:
   * the cube root of its share of the volume by default.
   */
  readonly depth?: number;
  /**
   * How fast the water slows the body down, per second, at each wet point
   * (1): the drag of the water.
   */
  readonly drag?: number;
}

/** A body that floats: its options, and how wet it is. */
export interface Floater {
  readonly body: PhysicsBody;
  readonly points: readonly IVec3[];
  readonly volume: number;
  readonly depth: number;
  readonly drag: number;
  /** The share of the volume under water at the last step, from 0 to 1. */
  readonly submerged: number;
}

type FloaterState = { -readonly [K in keyof Floater]: Floater[K] };

/** The options of a {@link Buoyancy}. */
export interface BuoyancyOptions {
  /** Of the water, in kg/m³ (1025: sea water). */
  readonly density?: number;
  /** The gravity, in m/s² (9.81). */
  readonly gravity?: number;
}

/**
 * Bodies floating on water (Archimedes): at each step, each point of a
 * body below the surface pushes it up by the weight of its share of the
 * water, and the water drags it, at that point; the body tilts and rolls
 * with the waves. The height of the water comes from a {@link WaterHeight}:
 * analytic for Gerstner waves, read back from the GPU (a frame late) for
 * an {@link OceanSpectrum}. On any physics engine of `@fdw/engine-physics`.
 *
 * @example
 * ```ts
 * const buoyancy = new Buoyancy(ocean);
 * buoyancy.add(body, { points: boxPoints({ x: 0.5, y: 0.5, z: 0.5 }), volume: 1 });
 * buoyancy.install(scheduler); // before the physics, in the fixed step
 * ```
 */
export class Buoyancy {
  readonly water: WaterHeight;
  readonly density: number;
  readonly gravity: number;
  private readonly _floaters = new Map<PhysicsBody, FloaterState>();
  private readonly _flow = { x: 0, z: 0 };

  constructor(water: WaterHeight, options: BuoyancyOptions = {}) {
    this.water = water;
    this.density = options.density ?? 1025;
    this.gravity = options.gravity ?? 9.81;
  }

  /** The floating bodies. */
  get floaters(): Iterable<Floater> {
    return this._floaters.values();
  }

  /** Makes a body float. */
  add(body: PhysicsBody, options: FloaterOptions): Floater {
    if (options.points.length === 0) {
      throw new Error('A floating body needs points');
    }
    if (!(options.volume > 0)) {
      throw new Error(`A floating body needs a volume: ${options.volume}`);
    }
    const share = options.volume / options.points.length;
    const floater: FloaterState = {
      body,
      points: options.points.map(({ x, y, z }) => ({ x, y, z })),
      volume: options.volume,
      depth: options.depth ?? Math.cbrt(share),
      drag: options.drag ?? 1,
      submerged: 0,
    };
    this._floaters.set(body, floater);
    return floater;
  }

  remove(body: PhysicsBody): void {
    this._floaters.delete(body);
  }

  /** The floater of a body. */
  floaterOf(body: PhysicsBody): Floater | undefined {
    return this._floaters.get(body);
  }

  /**
   * Pushes the bodies for the next step of the physics: the forces last
   * one step. Bodies removed from their world are forgotten.
   */
  step(): void {
    const point = { x: 0, y: 0, z: 0 };
    const force = { x: 0, y: 0, z: 0 };
    // The bodies of each world, to forget the removed ones.
    const alive = new Map<PhysicsBody['world'], Set<PhysicsBody>>();
    for (const [body, floater] of this._floaters) {
      let bodies = alive.get(body.world);
      if (!bodies) {
        bodies = new Set(body.world.bodies);
        alive.set(body.world, bodies);
      }
      if (!bodies.has(body)) {
        this._floaters.delete(body);
        continue;
      }
      const position = body.position;
      const rotation = body.rotation;
      const velocity = body.linearVelocity;
      const spin = body.angularVelocity;
      const count = floater.points.length;
      const lift = (this.density * this.gravity * floater.volume) / count;
      const drag = (floater.drag * body.mass) / count;
      const flow = this.water.velocityAt ? this._flow : undefined;
      let wet = 0;
      for (const local of floater.points) {
        rotate(rotation, local, point);
        // The arm from the center of the body, then the point in the world.
        const rx = point.x;
        const ry = point.y;
        const rz = point.z;
        point.x += position.x;
        point.y += position.y;
        point.z += position.z;
        const depth = this.water.heightAt(point.x, point.z) - point.y;
        const share = Math.min(Math.max(depth / floater.depth + 0.5, 0), 1);
        if (share <= 0) {
          continue;
        }
        wet += share;
        // The velocity of the point: v + ω × r.
        let vx = velocity.x + spin.y * rz - spin.z * ry;
        const vy = velocity.y + spin.z * rx - spin.x * rz;
        let vz = velocity.z + spin.x * ry - spin.y * rx;
        if (flow) {
          // Against the water, which carries the body along.
          this.water.velocityAt?.(point.x, point.z, flow);
          vx -= flow.x;
          vz -= flow.z;
        }
        force.x = -drag * share * vx;
        force.y = lift * share - drag * share * vy;
        force.z = -drag * share * vz;
        body.applyForce(force, point);
      }
      floater.submerged = wet / count;
      if (wet > 0 && body.sleeping) {
        // The waves move under it.
        body.wakeUp();
      }
    }
  }

  /**
   * Runs {@link Buoyancy.step} in the fixed step of a scheduler, before
   * the physics (`physics` by default).
   */
  install(
    scheduler: Scheduler,
    {
      name = 'buoyancy',
      before = ['physics'],
    }: { name?: string; before?: readonly string[] } = {},
  ): void {
    scheduler.add(name, () => this.step(), {
      phase: 'fixed',
      before: [...before],
    });
  }
}

// v turned by the unit quaternion q, into out.
function rotate(q: IQuat, v: IVec3, out: IVec3): IVec3 {
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t.
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/**
 * Points of a box of half extents around its center, for
 * {@link FloaterOptions.points}: a grid of `divisions` × `divisions` ×
 * `divisions` points, at the centers of as many equal cells.
 */
export function boxPoints(halfExtents: IVec3, divisions = 2): IVec3[] {
  const points: IVec3[] = [];
  const at = (half: number, i: number) =>
    -half + ((i + 0.5) * 2 * half) / divisions;
  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      for (let k = 0; k < divisions; k++) {
        points.push({
          x: at(halfExtents.x, i),
          y: at(halfExtents.y, j),
          z: at(halfExtents.z, k),
        });
      }
    }
  }
  return points;
}
