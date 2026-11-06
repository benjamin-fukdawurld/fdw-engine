import type { IVec3 } from '@fdw/engine-backend';
import {
  Aabb,
  Ray,
  signedDistance,
  type Vec3,
  type Volume,
} from '@fdw/engine-geometry';
import type { QueryOptions, Scene } from '@fdw/engine-scene';
import type { CharacterController } from '../api';

/** Options of a {@link SceneCharacter}. */
export interface SceneCharacterOptions extends QueryOptions {
  /** The radius of its capsule. Default 0.3. */
  readonly radius?: number;
  /** The height of its capsule, from end to end. Default 1.8. */
  readonly height?: number;
  /** The center of its capsule. Default the origin. */
  readonly position?: Partial<IVec3>;
  /** A gap kept to the surfaces, in meters. Default 0.02. */
  readonly offset?: number;
  /** The steepest slope it stands on, in radians. Default 45°. */
  readonly maxSlope?: number;
  /** Climbs steps up to this height (0: none). Default 0.3. */
  readonly stepHeight?: number;
  /** Stays on the ground down to this height (0: none). Default 0.3. */
  readonly snapToGround?: number;
  /** A ground under everything (a terrain): its height at x, z. */
  readonly ground?: (x: number, z: number) => number;
  /**
   * Leaves out the renderers it is not stopped by (its own node, the
   * pickups); default: none.
   */
  readonly ignore?: (entity: number) => boolean;
}

/** The result of a move of a {@link SceneCharacter}. */
export interface SceneCharacterMove {
  /** What was done of the movement asked. */
  readonly movement: IVec3;
  /** On the ground after the move. */
  readonly grounded: boolean;
  /** The renderers touched on the way (their entities). */
  readonly collisions: readonly number[];
}

// The iterations of the search along the segment of the capsule.
const searchSteps = 20;
const golden = (Math.sqrt(5) - 1) / 2;
// Passes of depenetration per sub-step.
const passes = 4;
// The volumes signedDistance() measures; the others stand for their bounds.
const exact = new Set(['aabb', 'obb', 'sphere', 'capsule']);

/**
 * A character controller against the volumes of a scene, without a
 * physics engine: a vertical capsule that slides along the walls, climbs
 * the steps and the gentle slopes, and stays on the ground. The obstacles
 * are the renderers of the scene: the volume given to `setMesh` (box,
 * oriented box, sphere, capsule) when there is one, the bounds of their
 * mesh otherwise; and a ground function, for a terrain.
 *
 * The same `move` as the {@link PhysicsCharacter} of a physics engine: the
 * code of the game does not change.
 *
 * @example
 * ```ts
 * const character = new SceneCharacter(scene, {
 *   position: { y: 1 },
 *   ignore: (entity) => entity === hero.entity,
 * });
 * // Each fixed step: the input, gravity.
 * velocityY = character.grounded ? 0 : velocityY - 9.81 * dt;
 * character.move({ x: vx * dt, y: velocityY * dt, z: vz * dt });
 * hero.transform.position = character.position;
 * ```
 */
export class SceneCharacter implements CharacterController {
  readonly radius: number;
  readonly height: number;
  readonly offset: number;
  readonly stepHeight: number;
  readonly snapToGround: number;
  private readonly _minNormalY: number;
  private readonly _position: Vec3 = [0, 0, 0];
  private _grounded = false;
  // Landing on a step: its edges count as ground.
  private _stepping = false;
  private readonly _collisions = new Set<number>();
  // Scratch values.
  private readonly _volumes: { entity: number; volume: Volume }[] = [];
  private readonly _bounds = new Aabb();
  private readonly _normal: Vec3 = [0, 0, 0];
  private readonly _point: Vec3 = [0, 0, 0];
  private readonly _push: Vec3 = [0, 0, 0];
  private readonly _ray = new Ray([0, 0, 0], [0, -1, 0]);

  constructor(
    readonly scene: Scene,
    readonly options: SceneCharacterOptions = {},
  ) {
    this.radius = options.radius ?? 0.3;
    this.height = Math.max(options.height ?? 1.8, 2 * this.radius);
    this.offset = options.offset ?? 0.02;
    this.stepHeight = options.stepHeight ?? 0.3;
    this.snapToGround = options.snapToGround ?? 0.3;
    this._minNormalY = Math.cos(options.maxSlope ?? Math.PI / 4);
    this._position[0] = options.position?.x ?? 0;
    this._position[1] = options.position?.y ?? 0;
    this._position[2] = options.position?.z ?? 0;
  }

  /** The center of the capsule. */
  get position(): IVec3 {
    const [x, y, z] = this._position;
    return { x, y, z };
  }

  /** On the ground after the last move. */
  get grounded(): boolean {
    return this._grounded;
  }

  /** Moves at once, through everything. */
  teleport(position: Partial<IVec3>): void {
    this._position[0] = position.x ?? this._position[0];
    this._position[1] = position.y ?? this._position[1];
    this._position[2] = position.z ?? this._position[2];
    this._grounded = false;
  }

  /**
   * Moves by `movement` (meters, for this step, gravity included), as far
   * as the obstacles let it.
   */
  move(movement: IVec3): SceneCharacterMove {
    const p = this._position;
    const start: Vec3 = [p[0], p[1], p[2]];
    const wasGrounded = this._grounded;
    this._collisions.clear();
    this.gather(movement);

    let grounded = this.travel(movement.x, movement.y, movement.z);
    const horizontal = Math.hypot(movement.x, movement.z);
    // Blocked while walking on the ground: a step, maybe.
    if (wasGrounded && this.stepHeight > 0 && horizontal > 1e-6) {
      const done = Math.hypot(p[0] - start[0], p[2] - start[2]);
      if (done < horizontal * 0.9) {
        const walked: Vec3 = [p[0], p[1], p[2]];
        const walkedGrounded = grounded;
        p[0] = start[0];
        p[1] = start[1];
        p[2] = start[2];
        this.travel(0, this.stepHeight, 0);
        this.travel(movement.x, 0, movement.z);
        const climbed = Math.hypot(p[0] - start[0], p[2] - start[2]);
        this._stepping = true;
        const landed = this.travel(
          0,
          -this.stepHeight + Math.min(movement.y, 0),
          0,
        );
        this._stepping = false;
        if (
          !landed ||
          climbed <= done + 1e-4 ||
          p[1] > start[1] + this.stepHeight + 1e-4 ||
          !this.walkableBelow()
        ) {
          p[0] = walked[0];
          p[1] = walked[1];
          p[2] = walked[2];
          grounded = walkedGrounded;
        } else {
          grounded = true;
        }
      }
    }
    // Kept on the ground down a slope or a step.
    if (wasGrounded && !grounded && movement.y <= 0 && this.snapToGround > 0) {
      const before: Vec3 = [p[0], p[1], p[2]];
      if (this.travel(0, -this.snapToGround, 0)) {
        grounded = true;
      } else {
        p[0] = before[0];
        p[1] = before[1];
        p[2] = before[2];
      }
    }
    this._grounded = grounded;
    return {
      movement: { x: p[0] - start[0], y: p[1] - start[1], z: p[2] - start[2] },
      grounded,
      collisions: [...this._collisions],
    };
  }

  // The volumes near the whole move, once.
  private gather(movement: IVec3): void {
    const p = this._position;
    const reach =
      this.radius +
      this.offset +
      Math.max(this.stepHeight, this.snapToGround) +
      0.1;
    const half = this.height / 2;
    const box = this._bounds;
    for (let i = 0; i < 3; i++) {
      const m = i === 0 ? movement.x : i === 1 ? movement.y : movement.z;
      const extent = i === 1 ? half + reach : reach;
      box.min[i] = Math.min(p[i], p[i] + m) - extent;
      box.max[i] = Math.max(p[i], p[i] + m) + extent;
    }
    this._volumes.length = 0;
    const ignore = this.options.ignore;
    this.scene.queryVolumeEntities(
      box,
      (entity) => {
        if (ignore?.(entity)) return;
        const own = this.scene.MeshRenderer.volume[entity] as
          Volume | undefined;
        const volume = own
          ? exact.has(own.kind)
            ? own
            : own.bounds(new Aabb())
          : this.scene.bounds(new Aabb(), entity);
        this._volumes.push({ entity, volume });
      },
      this.options,
    );
  }

  // Moves in sub-steps no longer than half the radius, pushed out of the
  // volumes after each; true when it touched walkable ground.
  private travel(x: number, y: number, z: number): boolean {
    const length = Math.hypot(x, y, z);
    const steps = Math.max(1, Math.ceil(length / (this.radius * 0.5)));
    const p = this._position;
    let grounded = false;
    for (let s = 0; s < steps; s++) {
      p[0] += x / steps;
      p[1] += y / steps;
      p[2] += z / steps;
      if (this.resolve()) grounded = true;
    }
    return grounded;
  }

  // Pushes the capsule out of what it overlaps; true when on walkable
  // ground.
  private resolve(): boolean {
    const p = this._position;
    const r = this.radius;
    const skin = r + this.offset;
    const half = this.height / 2 - r;
    const normal = this._normal;
    const point = this._point;
    const push = this._push;
    let grounded = false;
    for (let pass = 0; pass < passes; pass++) {
      let moved = false;
      for (const { entity, volume } of this._volumes) {
        // The point of the segment closest to the volume: the distance
        // along the segment is convex, a golden-section search finds it.
        let a = -half;
        let b = half;
        let c = b - golden * (b - a);
        let d = a + golden * (b - a);
        let fc = this.distanceAt(volume, c);
        let fd = this.distanceAt(volume, d);
        for (let i = 0; i < searchSteps; i++) {
          if (fc < fd) {
            b = d;
            d = c;
            fd = fc;
            c = b - golden * (b - a);
            fc = this.distanceAt(volume, c);
          } else {
            a = c;
            c = d;
            fc = fd;
            d = a + golden * (b - a);
            fd = this.distanceAt(volume, d);
          }
        }
        const t = (a + b) / 2;
        point[0] = p[0];
        point[1] = p[1] + t;
        point[2] = p[2];
        const distance = signedDistance(volume, point, normal) as number;
        if (distance >= skin - 1e-6) continue;
        this._collisions.add(entity);
        const depth = skin - distance;
        if (normal[1] >= (this._stepping ? 0.05 : this._minNormalY)) {
          // Walkable: straight up, no sliding down the slope.
          push[0] = 0;
          push[1] = depth / normal[1];
          push[2] = 0;
          grounded = true;
        } else {
          push[0] = normal[0] * depth;
          push[1] = normal[1] * depth;
          push[2] = normal[2] * depth;
        }
        p[0] += push[0];
        p[1] += push[1];
        p[2] += push[2];
        moved = true;
      }
      if (this.resolveGround()) {
        grounded = true;
        moved = true;
      }
      if (!moved) break;
    }
    return grounded;
  }

  // Whether the surface right under the axis of the capsule is walkable:
  // the top of a step, not a steep slope.
  private walkableBelow(): boolean {
    const p = this._position;
    const ray = this._ray;
    ray.origin[0] = p[0];
    ray.origin[1] = p[1];
    ray.origin[2] = p[2];
    let nearest = Infinity;
    let normalY = 0;
    for (const { volume } of this._volumes) {
      const t = volume.raycast(ray);
      if (t === undefined || t >= nearest || t <= 0) continue;
      nearest = t;
      const point = this._point;
      point[0] = p[0];
      // Just inside the surface hit: the gradient of its face.
      point[1] = p[1] - t - 1e-4;
      point[2] = p[2];
      signedDistance(volume, point, this._normal);
      normalY = this._normal[1];
    }
    const ground = this.options.ground;
    if (ground) {
      const h = ground(p[0], p[2]);
      if (p[1] - h < nearest) {
        const e = 0.05;
        const sx = (ground(p[0] + e, p[2]) - ground(p[0] - e, p[2])) / (2 * e);
        const sz = (ground(p[0], p[2] + e) - ground(p[0], p[2] - e)) / (2 * e);
        normalY = 1 / Math.hypot(sx, 1, sz);
      }
    }
    return normalY >= this._minNormalY;
  }

  private distanceAt(volume: Volume, t: number): number {
    const point = this._point;
    point[0] = this._position[0];
    point[1] = this._position[1] + t;
    point[2] = this._position[2];
    return signedDistance(volume, point) as number;
  }

  // The ground function: the bottom of the capsule kept above it.
  private resolveGround(): boolean {
    const ground = this.options.ground;
    if (!ground) return false;
    const p = this._position;
    const bottom = p[1] - this.height / 2;
    const h = ground(p[0], p[2]);
    const gap = bottom - h;
    if (gap >= this.offset - 1e-6) return false;
    // The slope, by finite differences.
    const e = 0.05;
    const sx = (ground(p[0] + e, p[2]) - ground(p[0] - e, p[2])) / (2 * e);
    const sz = (ground(p[0], p[2] + e) - ground(p[0], p[2] - e)) / (2 * e);
    const ny = 1 / Math.hypot(sx, 1, sz);
    const depth = this.offset - gap;
    if (ny >= this._minNormalY) {
      p[1] += depth;
      return true;
    }
    // Too steep: pushed along the normal, sliding down.
    const k = depth * ny * ny;
    p[0] += -sx * k;
    p[1] += k;
    p[2] += -sz * k;
    return false;
  }
}
