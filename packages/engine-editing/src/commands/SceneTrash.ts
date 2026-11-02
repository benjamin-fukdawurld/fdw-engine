import type { Node, Scene } from '@fdw/engine-scene';

/** Told when nodes go to the trash of a scene, or come back from it. */
export type TrashListener = (
  node: Node,
  change: 'discarded' | 'restored',
) => void;

const trashes = new WeakMap<Scene, SceneTrash>();

/**
 * Moves a node under a parent (keeping its local transform), before
 * `before`, or last when `before` is not a child of the parent: the place
 * a command puts back.
 */
export function placeUnder(node: Node, parent: Node, before?: Node): void {
  const { scene } = parent;
  scene.setParent(node.entity, parent.entity);
  if (!before?.alive || before === node || before.parent !== parent) {
    return;
  }
  // Added last by the scene: linked again before `before`, in place (the
  // siblings do not move).
  const { Hierarchy } = scene;
  const entity = node.entity;
  const previous = Hierarchy.previous[entity];
  Hierarchy.next[previous] = -1;
  Hierarchy.last[parent.entity] = previous;
  const prior = Hierarchy.previous[before.entity];
  Hierarchy.previous[entity] = prior;
  Hierarchy.next[entity] = before.entity;
  Hierarchy.previous[before.entity] = entity;
  if (prior >= 0) {
    Hierarchy.next[prior] = entity;
  } else {
    Hierarchy.first[parent.entity] = entity;
  }
}

/**
 * Where nodes are among their siblings: for each, the first sibling after
 * it that is not one of the nodes, to put them back before it. In the order
 * to put them back (by parent, the first child first).
 */
export function placesOf(
  nodes: readonly Node[],
): { node: Node; parent: Node; before?: Node }[] {
  const moved = new Set(nodes);
  const places: { node: Node; parent: Node; before?: Node; index: number }[] =
    [];
  for (const node of nodes) {
    const parent = node.parent;
    if (!parent) {
      continue;
    }
    const children = parent.children;
    const index = children.indexOf(node);
    const before = children.slice(index + 1).find((s) => !moved.has(s));
    places.push({ node, parent, index, ...(before && { before }) });
  }
  places.sort((a, b) => a.index - b.index);
  return places.map(({ node, parent, before }) => ({
    node,
    parent,
    ...(before && { before }),
  }));
}

/**
 * Where the commands put the nodes they remove, to put them back when
 * undone: a hidden branch out of the tree of the scene (not under its
 * root), so the nodes keep their entity, their components and their
 * handles. They are not drawn nor found by the queries; the commands
 * destroy them for good when the history drops them.
 */
export class SceneTrash {
  private readonly _branch: number;
  private readonly _listeners: TrashListener[] = [];

  private constructor(readonly scene: Scene) {
    // A second root, hidden: what is under it is not drawn.
    this._branch = scene.create(-1, { name: 'trash', visible: false });
  }

  /** The trash of a scene, created on first use. */
  static of(scene: Scene): SceneTrash {
    let trash = trashes.get(scene);
    if (!trash) {
      trash = new SceneTrash(scene);
      trashes.set(scene, trash);
    }
    return trash;
  }

  /** The trash of a scene, if it has one already. */
  static peek(scene: Scene): SceneTrash | undefined {
    return trashes.get(scene);
  }

  /** Whether a node is in the trash (or below a node that is). */
  contains(node: Node): boolean {
    const { Hierarchy } = this.scene;
    for (let e = node.entity; e >= 0; e = Hierarchy.parent[e]) {
      if (e === this._branch) {
        return true;
      }
    }
    return false;
  }

  /** Moves a node (and its branch) to the trash. */
  discard(node: Node): void {
    this.scene.setParent(node.entity, this._branch);
    this.emit(node, 'discarded');
  }

  /**
   * Puts a node of the trash back under a parent: before `before` (its place
   * among its siblings), or last when `before` is not a child of it.
   */
  restore(node: Node, parent: Node, before?: Node): void {
    placeUnder(node, parent, before);
    this.emit(node, 'restored');
  }

  /** Calls `listener` when nodes are discarded or restored; returns a function that stops. */
  listen(listener: TrashListener): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) {
        this._listeners.splice(index, 1);
      }
    };
  }

  private emit(node: Node, change: 'discarded' | 'restored'): void {
    for (const listener of [...this._listeners]) {
      listener(node, change);
    }
  }
}
