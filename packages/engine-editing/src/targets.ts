import { Transform } from '@fdw/engine-core';
import { Aabb, type Matrix4 } from '@fdw/engine-geometry';
import { Node } from '@fdw/engine-scene';
import { SceneTrash } from './commands/SceneTrash';
import { compose, type Trs } from './math';

/**
 * What the tools move: a node of a scene, or a bare Transform (an item
 * drawn without a scene, placed in the world).
 */
export type Editable = Node | Transform;

/** The local position, rotation and scale of a transform. */
export function readTrs(transform: Transform): Trs {
  const { position: p, rotation: r, scale: s } = transform;
  return {
    position: [p.x, p.y, p.z],
    rotation: [r.x, r.y, r.z, r.w],
    scale: [s.x, s.y, s.z],
  };
}

/** Writes a local position, rotation and scale: one change of the transform. */
export function writeTrs(
  transform: Transform,
  { position, rotation, scale }: Trs,
): void {
  transform.position.set(position);
  transform.rotation.set(rotation);
  transform.scale.set(scale);
}

/** The transform of an editable. */
export const transformOf = (target: Editable): Transform =>
  target instanceof Node ? target.transform : target;

/**
 * Whether an editable is still in its scene: a node not destroyed nor in
 * the trash of the commands.
 */
export const isAlive = (target: Editable): boolean =>
  target instanceof Node
    ? target.alive && !SceneTrash.peek(target.scene)?.contains(target)
    : true;

/** The world matrix of the parent of an editable; undefined at the root. */
export function parentMatrix(target: Editable): Matrix4 | undefined {
  if (!(target instanceof Node)) {
    return undefined;
  }
  return target.parent?.worldMatrix;
}

/** The world matrix of an editable. */
export function worldMatrix(target: Editable): Matrix4 {
  if (target instanceof Node) {
    return target.worldMatrix;
  }
  const { position, rotation, scale } = readTrs(target);
  return compose(position, rotation, scale);
}

/**
 * The world bounds of an editable: those of the renderers of a node and of
 * its descendants, or its origin when they have none.
 */
export function worldBounds(target: Editable, out: Aabb = new Aabb()): Aabb {
  out.makeEmpty();
  if (target instanceof Node) {
    const box = new Aabb();
    target.traverse((node) => {
      if (node.scene.MeshRenderer.has(node.entity)) {
        out.union(node.scene.bounds(box, node.entity));
      }
    });
  }
  if (out.isEmpty()) {
    const m = worldMatrix(target);
    out.setFrom([m[12], m[13], m[14]], [m[12], m[13], m[14]]);
  }
  return out;
}

/**
 * The editables without those below another of the list (moving a node
 * moves its descendants: they must not move twice).
 */
export function topmost<T extends Editable>(targets: readonly T[]): T[] {
  const nodes = new Set(targets.filter((t) => t instanceof Node) as Node[]);
  return targets.filter((target) => {
    if (!(target instanceof Node)) {
      return true;
    }
    for (let p = target.parent; p; p = p.parent) {
      if (nodes.has(p)) {
        return false;
      }
    }
    return true;
  });
}
