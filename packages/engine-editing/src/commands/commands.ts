import type { Node, NodeOptions } from '@fdw/engine-scene';
import type { Command } from '../history/History';
import type { Trs } from '../math';
import {
  type Editable,
  isAlive,
  readTrs,
  transformOf,
  writeTrs,
} from '../targets';
import { SceneTrash } from './SceneTrash';

/**
 * Sets the local transforms of editables (nodes, transforms) from values
 * before to values after: what a gizmo records at the end of a drag.
 * The removed nodes are skipped.
 */
export class TransformCommand implements Command {
  constructor(
    readonly label: string,
    readonly targets: readonly Editable[],
    readonly before: readonly Trs[],
    readonly after: readonly Trs[],
  ) {
    if (before.length !== targets.length || after.length !== targets.length) {
      throw new Error('One transform before and after per target');
    }
  }

  /** The current transforms of editables: the `before` or `after` of a command. */
  static capture(targets: readonly Editable[]): Trs[] {
    return targets.map((target) => readTrs(transformOf(target)));
  }

  do(): void {
    this.apply(this.after);
  }

  undo(): void {
    this.apply(this.before);
  }

  private apply(values: readonly Trs[]): void {
    this.targets.forEach((target, i) => {
      if (isAlive(target)) {
        writeTrs(transformOf(target), values[i]);
      }
    });
  }
}

/**
 * Sets a value through a getter and a setter: a name, a color, a material,
 * a field of a component. Consecutive commands of the same `key` merge (the
 * steps of a slider make one entry).
 */
export class PropertyCommand<T> implements Command {
  private readonly _before: T;
  private _after: T;

  constructor(
    readonly label: string,
    private readonly _access: {
      readonly get: () => T;
      readonly set: (value: T) => void;
    },
    value: T,
    /** What merges: the same key, the same property. */
    readonly key?: unknown,
  ) {
    this._before = _access.get();
    this._after = value;
  }

  do(): void {
    this._access.set(this._after);
  }

  undo(): void {
    this._access.set(this._before);
  }

  merge(next: Command): boolean {
    if (
      !(next instanceof PropertyCommand) ||
      this.key === undefined ||
      next.key !== this.key
    ) {
      return false;
    }
    this._after = next._after as T;
    return true;
  }
}

/**
 * Creates a node under a parent, set up by `build` (its mesh, its
 * components) once. Undone, the node goes to the trash of the scene;
 * redone, it comes back: the same node, the same entity.
 */
export class CreateNodeCommand implements Command {
  private _node?: Node;

  constructor(
    readonly label: string,
    private readonly _parent: Node,
    private readonly _options: NodeOptions = {},
    private readonly _build?: (node: Node) => void,
  ) {}

  /** The node created, once done. */
  get node(): Node | undefined {
    return this._node;
  }

  do(): void {
    if (this._node) {
      SceneTrash.of(this._parent.scene).restore(this._node, this._parent);
      return;
    }
    this._node = this._parent.add(this._options);
    this._build?.(this._node);
  }

  undo(): void {
    if (this._node?.alive) {
      SceneTrash.of(this._parent.scene).discard(this._node);
    }
  }

  dispose(undone: boolean): void {
    if (undone && this._node?.alive) {
      this._node.remove();
    }
  }
}

/**
 * Removes nodes (and their branches): they go to the trash of their scene,
 * and come back under their parent when undone. Destroyed for good when
 * the history drops the command.
 */
export class DeleteNodesCommand implements Command {
  private readonly _nodes: Node[];
  private readonly _parents: Node[];

  constructor(
    readonly label: string,
    nodes: readonly Node[],
  ) {
    // Removing a node removes its descendants: only the topmost are kept.
    const all = new Set(nodes);
    this._nodes = nodes.filter((node) => {
      for (let p = node.parent; p; p = p.parent) {
        if (all.has(p)) {
          return false;
        }
      }
      return node.parent !== undefined;
    });
    this._parents = this._nodes.map((node) => node.parent as Node);
  }

  get nodes(): readonly Node[] {
    return this._nodes;
  }

  do(): void {
    for (const node of this._nodes) {
      if (node.alive) {
        SceneTrash.of(node.scene).discard(node);
      }
    }
  }

  undo(): void {
    this._nodes.forEach((node, i) => {
      if (node.alive && this._parents[i].alive) {
        SceneTrash.of(node.scene).restore(node, this._parents[i]);
      }
    });
  }

  dispose(undone: boolean): void {
    if (!undone) {
      for (const node of this._nodes) {
        if (node.alive) {
          node.remove();
        }
      }
    }
  }
}

/** Moves nodes under another parent, keeping their local transforms. */
export class ReparentCommand implements Command {
  private readonly _before: Node[];

  constructor(
    readonly label: string,
    private readonly _nodes: readonly Node[],
    private readonly _parent: Node,
  ) {
    this._before = _nodes.map((node) => node.parent as Node);
  }

  do(): void {
    for (const node of this._nodes) {
      this._parent.add(node);
    }
  }

  undo(): void {
    this._nodes.forEach((node, i) => this._before[i].add(node));
  }
}
