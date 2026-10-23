import type { Layout } from './layout';
import type { ViewSpec } from './plugins/contributions';
import type { EditorStore } from './state/editorStore';
import type { Registry } from './state/registry';
import type { IDisposable } from './state/services';

/** What the shell does with the panels of dockview (Workbench.tsx). */
export interface WorkbenchApi {
  /** The sizes of the docks and the panels of each area. */
  toJSON(): Pick<Layout, 'grid' | 'areas'>;
  /** The ids of the panels open, in any area. */
  openPanels(): string[];
  /** Shows the panel: in its area by default if it is not open. */
  openPanel(id: string): void;
  closePanel(id: string): void;
}

/** What the shell gives the workbench once its panels are laid out. */
export interface WorkbenchAttachment {
  readonly api: WorkbenchApi;
  /** The default layout, the chrome and the panels. */
  resetLayout(): void;
}

/**
 * The panels and the chrome for the commands (the built-in plugins): the
 * views open, opened and closed; the layout reset; the command palette.
 * The shell attaches its dockview once laid out.
 */
export class WorkbenchService {
  readonly #editor: EditorStore;
  readonly #views: Registry<ViewSpec>;
  readonly #listeners = new Set<() => void>();
  #attached?: WorkbenchAttachment;
  #openViews: readonly string[] = [];
  #palette = false;

  constructor(editor: EditorStore, views: Registry<ViewSpec>) {
    this.#editor = editor;
    this.#views = views;
  }

  attach(attachment: WorkbenchAttachment): IDisposable {
    this.#attached = attachment;
    this.setOpenViews(attachment.api.openPanels());
    return {
      dispose: () => {
        if (this.#attached === attachment) this.#attached = undefined;
      },
    };
  }

  /** The ids of the views open; the same array until a change. */
  openViews(): readonly string[] {
    return this.#openViews;
  }

  /** Told by the shell when panels are opened or closed. */
  setOpenViews(ids: readonly string[]): void {
    if (
      ids.length === this.#openViews.length &&
      ids.every((id, index) => this.#openViews[index] === id)
    ) {
      return;
    }
    this.#openViews = [...ids];
    this.#changed();
  }

  /** Shows the view, its dock first; opens it in its area if it is not open. */
  openView(id: string): void {
    const spec = this.#views.get(id);
    const area = spec?.location;
    const { docks } = this.#editor.getSnapshot().context;
    if (area && area !== 'center' && !docks[area]) {
      this.#editor.trigger.setDock({ dock: area, shown: true });
    }
    this.#attached?.api.openPanel(id);
  }

  closeView(id: string): void {
    this.#attached?.api.closePanel(id);
  }

  toggleView(id: string): void {
    if (this.#openViews.includes(id)) this.closeView(id);
    else this.openView(id);
  }

  resetLayout(): void {
    this.#attached?.resetLayout();
  }

  paletteOpen(): boolean {
    return this.#palette;
  }

  setPalette(open: boolean): void {
    if (this.#palette === open) return;
    this.#palette = open;
    this.#changed();
  }

  /** Listens to the changes; returns the unsubscription. Bound, for React. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
