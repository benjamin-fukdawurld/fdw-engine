import { createStore } from '@xstate/store';
import {
  defaultChrome,
  type Chrome,
  type DockId,
  type ToolbarLayout,
} from '../layout';

/**
 * The serializable state of the editor (design/editor-state.md §2): the
 * chrome, the selection, the state of each plugin. Ids only, never an
 * object of the engine.
 */
export interface EditorStoreContext extends Chrome {
  /** The ids of the objects selected, the active one last. */
  readonly selection: readonly string[];
  /** The state of each plugin (its `ctx.state`, step 12 of P18), as JSON. */
  readonly plugins: Readonly<Record<string, unknown>>;
}

export function createEditorStore(restored: Partial<EditorStoreContext> = {}) {
  return createStore({
    context: {
      ...defaultChrome,
      selection: [],
      plugins: {},
      ...restored,
    } as EditorStoreContext,
    on: {
      setDock: (context, event: { dock: DockId; shown: boolean }) => ({
        ...context,
        docks: { ...context.docks, [event.dock]: event.shown },
      }),
      setToolbar: (context, event: { id: string; layout: ToolbarLayout }) => ({
        ...context,
        toolbars: { ...context.toolbars, [event.id]: event.layout },
      }),
      setStatusBar: (context, event: { shown: boolean }) => ({
        ...context,
        statusBar: event.shown,
      }),
      resetChrome: (context) => ({ ...context, ...defaultChrome }),
      select: (context, event: { ids: readonly string[] }) => ({
        ...context,
        selection: event.ids,
      }),
      setPluginState: (context, event: { plugin: string; state: unknown }) => ({
        ...context,
        plugins: { ...context.plugins, [event.plugin]: event.state },
      }),
    },
  });
}

export type EditorStore = ReturnType<typeof createEditorStore>;
