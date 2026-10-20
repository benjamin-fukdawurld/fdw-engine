/** How picked objects change a selection. */
export type SelectionMode = 'replace' | 'add' | 'remove' | 'toggle';

/**
 * The mode of a click or a rectangle by its modifiers, as in most editors:
 * Shift adds, Ctrl (Cmd on macOS) toggles, Alt removes, none replaces.
 */
export function selectionMode(modifiers: {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}): SelectionMode {
  return modifiers.ctrlKey || modifiers.metaKey
    ? 'toggle'
    : modifiers.shiftKey
      ? 'add'
      : modifiers.altKey
        ? 'remove'
        : 'replace';
}

/**
 * The selected objects, in the order they were selected: the last one is
 * the active object (the one whose origin a gizmo can pivot on, whose
 * properties an inspector shows). And the object under the pointer.
 *
 * Not in the history of the commands, as in most editors: undoing changes
 * the objects, not what is selected.
 */
export class Selection<T = unknown> {
  private _items: T[] = [];
  private _hovered: T | undefined;
  private readonly _listeners: (() => void)[] = [];
  private readonly _hoverListeners: (() => void)[] = [];

  /** The selected objects, the active one last. */
  get items(): readonly T[] {
    return this._items;
  }

  get size(): number {
    return this._items.length;
  }

  /** The last object selected. */
  get active(): T | undefined {
    return this._items.at(-1);
  }

  has(item: T): boolean {
    return this._items.includes(item);
  }

  /** Selects these objects only. */
  set(items: Iterable<T>): void {
    this.apply(items, 'replace');
  }

  add(...items: T[]): void {
    this.apply(items, 'add');
  }

  remove(...items: T[]): void {
    this.apply(items, 'remove');
  }

  toggle(...items: T[]): void {
    this.apply(items, 'toggle');
  }

  clear(): void {
    this.apply([], 'replace');
  }

  /**
   * Changes the selection by objects picked: replaced by them, extended,
   * reduced, or each toggled. An object added again becomes the active one.
   */
  apply(picked: Iterable<T>, mode: SelectionMode): void {
    const list = [...new Set(picked)];
    let next: T[];
    switch (mode) {
      case 'replace':
        next = list;
        break;
      case 'add':
        next = [...this._items.filter((item) => !list.includes(item)), ...list];
        break;
      case 'remove':
        next = this._items.filter((item) => !list.includes(item));
        break;
      case 'toggle':
        next = [
          ...this._items.filter((item) => !list.includes(item)),
          ...list.filter((item) => !this._items.includes(item)),
        ];
        break;
    }
    if (
      next.length === this._items.length &&
      next.every((item, i) => item === this._items[i])
    ) {
      return;
    }
    this._items = next;
    for (const listener of [...this._listeners]) {
      listener();
    }
  }

  /** Keeps only the objects `keep` accepts (the nodes still in the scene). */
  filter(keep: (item: T) => boolean): void {
    if (!this._items.every(keep)) {
      this.set(this._items.filter(keep));
    }
    if (this._hovered !== undefined && !keep(this._hovered)) {
      this.hovered = undefined;
    }
  }

  /** The object under the pointer. */
  get hovered(): T | undefined {
    return this._hovered;
  }

  set hovered(item: T | undefined) {
    if (item !== this._hovered) {
      this._hovered = item;
      for (const listener of [...this._hoverListeners]) {
        listener();
      }
    }
  }

  /** Calls `listener` after each change of the selection; returns a function that stops. */
  onChange(listener: () => void): () => void {
    return subscribe(this._listeners, listener);
  }

  /** Calls `listener` when the hovered object changes; returns a function that stops. */
  onHover(listener: () => void): () => void {
    return subscribe(this._hoverListeners, listener);
  }
}

function subscribe(list: (() => void)[], listener: () => void): () => void {
  list.push(listener);
  return () => {
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
    }
  };
}
