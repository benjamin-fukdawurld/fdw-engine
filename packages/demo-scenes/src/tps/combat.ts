import type { IVec3 } from '@fdw/engine-backend';
import {
  Shapes,
  type PhysicsCollider,
  type PhysicsWorld,
} from '@fdw/engine-physics';

// The blows of the TPS: volumes of attack tested against the bodies of the
// other side while the animation strikes, each target hit once per blow.

/** A blow in progress: how hard, whom it hurts, what it already hit. */
export class Blow {
  readonly hit = new Set<PhysicsCollider>();
  constructor(
    readonly damage: number,
    // The colliders of the other side (the bodies of the enemies, of the
    // hero).
    readonly against: (collider: PhysicsCollider) => boolean,
  ) {}
}

/** What a blow did: the collider it hit (a body of the other side), where. */
export interface Strike {
  readonly collider: PhysicsCollider;
  readonly damage: number;
  readonly point: IVec3;
}

const sub = (a: IVec3, b: IVec3) => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

// The rotation turning +y (the axis of a capsule) to a direction.
function alongY(d: IVec3): { x: number; y: number; z: number; w: number } {
  const length = Math.hypot(d.x, d.y, d.z) || 1;
  const [x, y, z] = [d.x / length, d.y / length, d.z / length];
  // From (0, 1, 0) to (x, y, z): axis (z, 0, -x), angle acos(y).
  if (y < -0.9999) return { x: 1, y: 0, z: 0, w: 0 };
  const w = 1 + y;
  const norm = Math.hypot(z, x, w);
  return { x: z / norm, y: 0, z: -x / norm, w: w / norm };
}

/**
 * Tests a capsule from `from` to `to` (a blade, an arm) against the bodies
 * the blow hurts: each collider is struck once per blow. Returns the new
 * strikes.
 */
export function strikeCapsule(
  world: PhysicsWorld,
  blow: Blow,
  from: IVec3,
  to: IVec3,
  radius: number,
): Strike[] {
  const axis = sub(to, from);
  const length = Math.hypot(axis.x, axis.y, axis.z);
  const middle = {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: (from.z + to.z) / 2,
  };
  const strikes: Strike[] = [];
  world.overlap(
    Shapes.capsule(Math.max(length / 2, 1e-3), radius),
    middle,
    alongY(axis),
    (collider) => {
      if (!blow.hit.has(collider)) {
        blow.hit.add(collider);
        strikes.push({ collider, damage: blow.damage, point: middle });
      }
    },
    { predicate: blow.against },
  );
  return strikes;
}

/** Tests a sphere (a fist, a mace) as strikeCapsule does. */
export function strikeSphere(
  world: PhysicsWorld,
  blow: Blow,
  center: IVec3,
  radius: number,
): Strike[] {
  const strikes: Strike[] = [];
  world.overlap(
    Shapes.sphere(radius),
    center,
    { x: 0, y: 0, z: 0, w: 1 },
    (collider) => {
      if (!blow.hit.has(collider)) {
        blow.hit.add(collider);
        strikes.push({ collider, damage: blow.damage, point: center });
      }
    },
    { predicate: blow.against },
  );
  return strikes;
}
