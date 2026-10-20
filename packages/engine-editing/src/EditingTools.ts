import { Node } from '@fdw/engine-scene';
import { DeleteNodesCommand } from './commands/commands';
import type { TransformGizmo } from './gizmo/TransformGizmo';
import type { History } from './history/History';
import type { Picker } from './selection/Picker';
import { type Selection, selectionMode } from './selection/Selection';
import { type Editable, isAlive } from './targets';
import { pointerPixel, type Viewport, type ViewportPoint } from './Viewport';

/**
 * A pointer event, as the tools read it: its pixel in the viewport (see
 * pointerPixel), its button and its modifiers. A PointerEvent with x and y
 * replaced fits.
 */
export interface ToolPointer extends ViewportPoint {
  /** 0 the primary button (the default), 1 the middle one, 2 the secondary. */
  readonly button?: number;
  /** 'mouse', 'pen' or 'touch': a finger gets a larger tolerance and no hover. */
  readonly pointerType?: string;
  /** Several pointers (fingers): only the first one pressed is followed. */
  readonly pointerId?: number;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * The ToolPointer of a pointer event over a canvas: its pixel (see
 * pointerPixel), its button, its type and its modifiers.
 */
export function toolPointer(
  event: Omit<ToolPointer, 'x' | 'y'> & {
    readonly offsetX: number;
    readonly offsetY: number;
  },
  canvas: Parameters<typeof pointerPixel>[1],
): ToolPointer {
  return {
    ...pointerPixel(event, canvas),
    button: event.button,
    pointerType: event.pointerType,
    pointerId: event.pointerId,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
  };
}

/** A key pressed, as the tools read it: a KeyboardEvent fits. */
export interface ToolKey {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

export interface EditingToolsOptions<T extends Editable> {
  readonly viewport: Viewport;
  readonly selection: Selection<T>;
  /** Finds the objects under a click or in a rectangle. */
  readonly picker?: Picker<T>;
  readonly gizmo?: TransformGizmo;
  /** Where the changes are recorded (the gizmo's, if it has none). */
  readonly history?: History;
  /** The pixels a press must move to become a rectangle. Default 4. */
  readonly dragThreshold?: number;
  /** The tolerance of the handles, in pixels, by pointer type. */
  readonly tolerance?: { readonly mouse?: number; readonly touch?: number };
}

/**
 * The tools of a viewport put together, for the pointer and the keyboard:
 * a press on a handle of the gizmo drags it; elsewhere, a click selects
 * what is under it and a drag selects what is in the rectangle (Shift
 * adds, Ctrl toggles, Alt removes); the pointer hovers objects and handles.
 * The selection gives the gizmo its targets.
 *
 * ```ts
 * const tools = new EditingTools({ viewport, selection, picker, gizmo, history });
 * canvas.addEventListener('pointerdown', (e) => {
 *   if (tools.pointerDown(toolPointer(e, canvas))) {
 *     canvas.setPointerCapture(e.pointerId);
 *   }
 * });
 * canvas.addEventListener('pointermove', (e) => tools.pointerMove(toolPointer(e, canvas)));
 * canvas.addEventListener('pointerup', (e) => tools.pointerUp(toolPointer(e, canvas)));
 * window.addEventListener('keydown', (e) => tools.keyDown(e) && e.preventDefault());
 * ```
 */
export class EditingTools<T extends Editable> {
  readonly viewport: Viewport;
  readonly selection: Selection<T>;
  readonly picker?: Picker<T>;
  readonly gizmo?: TransformGizmo;
  readonly history?: History;
  dragThreshold: number;
  private readonly _tolerance: { mouse: number; touch: number };
  // The press being followed: on a handle, or for a selection.
  private _press?: {
    readonly pointer: ToolPointer;
    readonly gizmo: boolean;
    to: ToolPointer;
    rectangle: boolean;
  };
  // The hover: one read back at a time, the last point asked waiting.
  private _hovering = false;
  private _hoverNext?: ViewportPoint;
  private readonly _listeners: (() => void)[] = [];

  constructor(options: EditingToolsOptions<T>) {
    this.viewport = options.viewport;
    this.selection = options.selection;
    this.picker = options.picker;
    this.gizmo = options.gizmo;
    this.history = options.history ?? options.gizmo?.history;
    if (this.gizmo && !this.gizmo.history) {
      this.gizmo.history = this.history;
    }
    this.dragThreshold = options.dragThreshold ?? 4;
    this._tolerance = {
      mouse: options.tolerance?.mouse ?? 8,
      touch: options.tolerance?.touch ?? 20,
    };
    this.selection.onChange(() => this.syncGizmo());
    this.syncGizmo();
  }

  /**
   * The rectangle being dragged, in pixels of the viewport: what the
   * application draws over the canvas. Undefined otherwise.
   */
  get rectangle(): { from: ViewportPoint; to: ViewportPoint } | undefined {
    const press = this._press;
    return press?.rectangle ? { from: press.pointer, to: press.to } : undefined;
  }

  /** Calls `listener` when the rectangle or the gizmo changes (to redraw an overlay). */
  onChange(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const index = this._listeners.indexOf(listener);
      if (index >= 0) {
        this._listeners.splice(index, 1);
      }
    };
  }

  /**
   * A press: grabs the handle under it, or starts a selection. Returns
   * whether the tools follow it (capture the pointer then); false for the
   * other buttons, left to the camera.
   */
  pointerDown(pointer: ToolPointer): boolean {
    if ((pointer.button ?? 0) !== 0 || this._press) {
      return false;
    }
    const grabbed =
      this.gizmo?.begin(this.viewport, pointer, {
        tolerance: this.tolerance(pointer),
      }) ?? false;
    this._press = { pointer, gizmo: grabbed, to: pointer, rectangle: false };
    this.changed();
    return true;
  }

  /** A move: drags the handle or the rectangle, or hovers. */
  pointerMove(pointer: ToolPointer): void {
    const press = this._press;
    if (press && !this.same(press.pointer, pointer)) {
      return;
    }
    if (press?.gizmo) {
      this.gizmo?.drag(this.viewport, pointer, {
        invertSnap: !!(pointer.ctrlKey || pointer.metaKey),
      });
      this.changed();
      return;
    }
    if (press) {
      press.to = pointer;
      const moved =
        Math.abs(pointer.x - press.pointer.x) +
          Math.abs(pointer.y - press.pointer.y) >
        this.dragThreshold;
      if (moved && !press.rectangle) {
        press.rectangle = true;
      }
      if (press.rectangle) {
        this.changed();
      }
      return;
    }
    if (pointer.pointerType !== 'touch') {
      this.hover(pointer);
    }
  }

  /** A release: ends the drag (one entry of the history), or selects. */
  pointerUp(pointer: ToolPointer): void {
    const press = this._press;
    if (!press || !this.same(press.pointer, pointer)) {
      return;
    }
    this._press = undefined;
    if (press.gizmo) {
      this.gizmo?.end();
      this.changed();
      return;
    }
    this.changed();
    const mode = selectionMode(pointer);
    const picker = this.picker;
    if (!picker) {
      return;
    }
    const picked = press.rectangle
      ? picker.pickRect(press.pointer, pointer)
      : picker.pick(pointer).then((item) => (item === undefined ? [] : [item]));
    void picked.then((items) =>
      this.selection.apply(items.filter(isAlive), mode),
    );
  }

  /** The pointer left the viewport: nothing is hovered. */
  pointerLeave(): void {
    this._hoverNext = undefined;
    this.selection.hovered = undefined;
    if (this.gizmo && !this.gizmo.dragging) {
      this.gizmo.hovered = undefined;
    }
  }

  /** Cancels what the pointer does: the drag goes back, the rectangle is dropped. */
  cancel(): boolean {
    const press = this._press;
    this._press = undefined;
    if (press?.gizmo) {
      this.gizmo?.cancel();
    }
    this.changed();
    return press !== undefined;
  }

  /** Undoes the last change (cancelling a drag first). */
  undo(): boolean {
    this.cancel();
    const done = this.history?.undo() ?? false;
    this.afterHistory();
    return done;
  }

  redo(): boolean {
    this.cancel();
    const done = this.history?.redo() ?? false;
    this.afterHistory();
    return done;
  }

  /**
   * Removes the selected nodes, in one command (undone, they come back),
   * and clears the selection.
   */
  deleteSelection(): boolean {
    const nodes = this.selection.items.filter(
      (item): item is T & Node => item instanceof Node && item.alive,
    );
    if (nodes.length === 0 || !this.history) {
      return false;
    }
    this.history.execute(
      new DeleteNodesCommand(
        nodes.length === 1 ? 'Delete' : `Delete ${nodes.length} objects`,
        nodes,
      ),
    );
    this.selection.clear();
    return true;
  }

  /**
   * The default shortcuts; returns whether the key was used (prevent its
   * default then):
   * - W, E, R: move, rotate, scale;
   * - X: the axes of the world or of the object; C: the pivot, center of
   *   the selection or origins;
   * - Ctrl+Z: undo; Ctrl+Y, Ctrl+Shift+Z: redo;
   * - Delete, Backspace: remove the selected nodes;
   * - Escape: cancel the drag, else clear the selection.
   */
  keyDown(key: ToolKey): boolean {
    const command = key.ctrlKey || key.metaKey;
    const name = key.key.toLowerCase();
    if (command && name === 'z') {
      return key.shiftKey ? this.redo() : this.undo();
    }
    if (command && name === 'y') {
      return this.redo();
    }
    if (command || key.altKey) {
      return false;
    }
    const gizmo = this.gizmo;
    switch (name) {
      case 'w':
      case 'e':
      case 'r':
        if (gizmo) {
          this.cancel();
          gizmo.mode =
            name === 'w' ? 'translate' : name === 'e' ? 'rotate' : 'scale';
          this.changed();
        }
        return !!gizmo;
      case 'x':
        if (gizmo) {
          gizmo.space = gizmo.space === 'world' ? 'local' : 'world';
          this.changed();
        }
        return !!gizmo;
      case 'c':
        if (gizmo) {
          gizmo.pivot = gizmo.pivot === 'center' ? 'origin' : 'center';
          this.changed();
        }
        return !!gizmo;
      case 'delete':
      case 'backspace':
        return this.deleteSelection();
      case 'escape':
        if (!this.cancel()) {
          this.selection.clear();
        }
        return true;
    }
    return false;
  }

  private tolerance(pointer: ToolPointer): number {
    return pointer.pointerType === 'touch'
      ? this._tolerance.touch
      : this._tolerance.mouse;
  }

  private same(a: ToolPointer, b: ToolPointer): boolean {
    return a.pointerId === undefined || a.pointerId === b.pointerId;
  }

  // The handle under the pointer at once; the object a frame or two later.
  private hover(point: ViewportPoint): void {
    const handle = this.gizmo?.hover(this.viewport, point);
    this.changed();
    if (handle) {
      this.selection.hovered = undefined;
      return;
    }
    this._hoverNext = point;
    if (this._hovering || !this.picker) {
      return;
    }
    this._hovering = true;
    const next = this._hoverNext;
    this._hoverNext = undefined;
    void this.picker
      .pick(next)
      .then((item) => {
        this.selection.hovered = item;
      })
      .finally(() => {
        this._hovering = false;
        if (this._hoverNext) {
          this.hover(this._hoverNext);
        }
      });
  }

  // The nodes removed or put back: the selection keeps those in the scene.
  private afterHistory(): void {
    this.selection.filter(isAlive);
    this.syncGizmo();
    this.changed();
  }

  private syncGizmo(): void {
    if (this.gizmo) {
      this.gizmo.targets = this.selection.items;
    }
  }

  private changed(): void {
    for (const listener of [...this._listeners]) {
      listener();
    }
  }
}
