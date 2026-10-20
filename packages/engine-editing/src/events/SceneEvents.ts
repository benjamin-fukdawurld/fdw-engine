import type { Scene, SceneChange } from '@fdw/engine-scene';
import { SceneTrash } from '../commands/SceneTrash';

/**
 * The changes of a scene since the last batch, by entity: what the panels
 * of an editor update (the tree of the scene, the inspector), what a save
 * marks as modified.
 */
export interface SceneChanges {
  /** Created, or put back from the trash (an undone removal). */
  readonly created: ReadonlySet<number>;
  /**
   * Destroyed, or moved to the trash (removed by a command). An entity
   * destroyed then reused in the same batch is in `removed` and `created`:
   * apply the removals first.
   */
  readonly removed: ReadonlySet<number>;
  /**
   * Their local transform, their parent or their visibility changed (their
   * descendants move with them, without being listed).
   */
  readonly moved: ReadonlySet<number>;
  /** A component given or taken, their mesh, name, layers, visibility… */
  readonly modified: ReadonlySet<number>;
}

export interface SceneEventsOptions {
  /**
   * When the changes are delivered: 'microtask' (the default) after the
   * code that made them, at most once per task; 'manual' when flush() is
   * called (once per frame, by the application).
   */
  readonly delivery?: 'microtask' | 'manual';
}

/**
 * The changes of a scene, collected and delivered in batches: an entity
 * created then removed in the same batch is not listed; a removed one is
 * not listed as moved or modified. Built on `scene.observe()` and the trash
 * of the commands.
 *
 * ```ts
 * const events = new SceneEvents(scene);
 * events.listen(({ created, removed, moved, modified }) => {
 *   tree.update(created, removed);
 *   inspector.refresh(moved, modified);
 * });
 * ```
 */
export class SceneEvents {
  private _created = new Set<number>();
  private _removed = new Set<number>();
  private _moved = new Set<number>();
  private _modified = new Set<number>();
  private _scheduled = false;
  private readonly _listeners: ((changes: SceneChanges) => void)[] = [];
  private readonly _stop: (() => void)[];
  readonly delivery: 'microtask' | 'manual';

  constructor(
    readonly scene: Scene,
    { delivery = 'microtask' }: SceneEventsOptions = {},
  ) {
    this.delivery = delivery;
    const trash = SceneTrash.of(scene);
    this._stop = [
      scene.observe((entity, change) => this.add(entity, change)),
      trash.listen((node, change) => {
        // The whole branch leaves the tree, or comes back.
        node.traverse(({ entity }) =>
          this.add(entity, change === 'discarded' ? 'removed' : 'restored'),
        );
      }),
    ];
  }

  /** Calls `listener` with each batch of changes; returns a function that stops. */
  listen(listener: (changes: SceneChanges) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /** Whether changes wait to be delivered. */
  get pending(): boolean {
    return (
      this._created.size +
        this._removed.size +
        this._moved.size +
        this._modified.size >
      0
    );
  }

  /** Delivers the changes collected, if any, and starts a new batch. */
  flush(): void {
    this._scheduled = false;
    if (!this.pending) {
      return;
    }
    const changes: SceneChanges = {
      created: this._created,
      removed: this._removed,
      moved: this._moved,
      modified: this._modified,
    };
    this._created = new Set();
    this._removed = new Set();
    this._moved = new Set();
    this._modified = new Set();
    for (const listener of [...this._listeners]) {
      listener(changes);
    }
  }

  /** Stops observing the scene. */
  dispose(): void {
    for (const stop of this._stop) {
      stop();
    }
  }

  private add(entity: number, change: SceneChange | 'restored'): void {
    switch (change) {
      case 'created':
        // A new entity: listed as created even if one of the same number
        // was removed in this batch (listeners apply the removals first).
        this._created.add(entity);
        break;
      case 'restored':
        // Back from the trash in the batch that put it there: it moved.
        if (this._removed.delete(entity)) {
          this._moved.add(entity);
        } else {
          // Created: its move back into the tree is not listed.
          this._created.add(entity);
          this._moved.delete(entity);
          this._modified.delete(entity);
        }
        break;
      case 'removed':
        this._moved.delete(entity);
        this._modified.delete(entity);
        // Created in this batch: never seen by the listeners.
        if (!this._created.delete(entity)) {
          this._removed.add(entity);
        }
        break;
      case 'moved':
        if (!this._created.has(entity) && !this._removed.has(entity)) {
          this._moved.add(entity);
        }
        break;
      case 'modified':
        if (!this._created.has(entity) && !this._removed.has(entity)) {
          this._modified.add(entity);
        }
        break;
    }
    if (this.delivery === 'microtask' && !this._scheduled) {
      this._scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }
}
