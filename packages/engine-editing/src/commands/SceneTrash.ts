import type { Node, Scene } from '@fdw/engine-scene';

/** Told when nodes go to the trash of a scene, or come back from it. */
export type TrashListener = (
  node: Node,
  change: 'discarded' | 'restored',
) => void;

const trashes = new WeakMap<Scene, SceneTrash>();

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

  /** Puts a node of the trash back under a parent. */
  restore(node: Node, parent: Node): void {
    this.scene.setParent(node.entity, parent.entity);
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
