import type { PhysicsBody } from './api';

/**
 * Forgets the bodies removed from their world: deletes them from `bodies`
 * (the keys of a map, or a set), for what follows bodies without being
 * told of their removal (the floaters of a sea, the obstacles of fluids).
 */
export function forgetRemovedBodies(bodies: {
  keys(): Iterable<PhysicsBody>;
  delete(body: PhysicsBody): boolean;
}): void {
  // The bodies of each world, gathered once.
  let alive: Map<PhysicsBody['world'], Set<PhysicsBody>> | undefined;
  for (const body of bodies.keys()) {
    alive ??= new Map();
    let inWorld = alive.get(body.world);
    if (!inWorld) {
      inWorld = new Set(body.world.bodies);
      alive.set(body.world, inWorld);
    }
    if (!inWorld.has(body)) {
      // Deleting the current entry keeps the iteration of a Map or a Set.
      bodies.delete(body);
    }
  }
}
