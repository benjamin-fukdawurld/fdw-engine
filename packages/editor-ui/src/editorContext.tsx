import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react';
import type { MenuItem } from './plugins/manifest';
import {
  toolActor,
  type EditorActor,
  type SlotId,
} from './state/editorMachine';
import type { EditorStoreContext } from './state/editorStore';
import type { EngineStoreContext } from './state/engineStore';
import type { EditorRuntime } from './state/runtime';

/** The runtime of the editor, for the panels and the bars. */
export const EditorContext = createContext<EditorRuntime | null>(null);

export function useEditor(): EditorRuntime {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor outside of the EditorShell');
  return value;
}

/** What a store or an actor gives: its snapshot, and its changes. */
interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (snapshot: T) => void): { unsubscribe(): void };
}

/**
 * The part of a store or of an actor that a component shows: rendered
 * again when it changes. The selector gives the same value for the same
 * snapshot (a part of it, not a new object).
 */
export function useSelector<T, S>(
  source: Observable<T>,
  select: (snapshot: T) => S,
): S {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = source.subscribe(listener);
      return () => subscription.unsubscribe();
    },
    [source],
  );
  return useSyncExternalStore(subscribe, () => select(source.getSnapshot()));
}

/** The state of the engine. */
export function useEngine(): EngineStoreContext {
  return useSelector(useEditor().engine, (snapshot) => snapshot.context);
}

/** The serializable state of the editor: the chrome, the selection. */
export function useEditorStore(): EditorStoreContext {
  return useSelector(useEditor().editor, (snapshot) => snapshot.context);
}

/** A part of the snapshot of the machine of the editor. */
export function useEditorMachine<S>(
  select: (snapshot: ReturnType<EditorActor['getSnapshot']>) => S,
): S {
  return useSelector(useEditor().machine, select);
}

/** Whether the context keys satisfy the clause; true without one. */
export function useWhen(when: string | undefined): boolean {
  const { keys } = useEditor();
  return useSyncExternalStore(keys.subscribe, () => keys.matches(when));
}

/** What a registry gives: its items, and their changes. */
interface ItemSource<T> {
  all(): readonly T[];
  subscribe(listener: () => void): () => void;
}

/** The items of a registry (the views, the toolbars), rendered again when it changes. */
export function useItems<T>(registry: ItemSource<T>): readonly T[] {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [registry],
  );
  return useSyncExternalStore(subscribe, () => registry.all());
}

/** The items of a menu, sorted. */
export function useMenu(menu: string): readonly MenuItem[] {
  const { menus } = useEditor();
  const subscribe = useCallback(
    (listener: () => void) => menus.subscribe(listener),
    [menus],
  );
  return useSyncExternalStore(subscribe, () => menus.items(menu));
}

/** The state of a plugin (its `ctx.state`), as JSON. */
export function usePluginState(plugin: string): unknown {
  return useSelector(
    useEditor().editor,
    (snapshot) => snapshot.context.plugins[plugin],
  );
}

/**
 * The snapshot of the tool active in the slot; undefined while it is idle.
 * Rendered again when the tool changes, or its state.
 */
export function useToolSnapshot(slot: SlotId): unknown {
  const { machine } = useEditor();
  const subscribe = useCallback(
    (listener: () => void) => {
      let child = toolActor(machine, slot);
      let childSubscription = child?.subscribe(listener);
      // The child changes with the tool: followed again at each change.
      const subscription = machine.subscribe(() => {
        const next = toolActor(machine, slot);
        if (next !== child) {
          childSubscription?.unsubscribe();
          child = next;
          childSubscription = child?.subscribe(listener);
        }
        listener();
      });
      return () => {
        subscription.unsubscribe();
        childSubscription?.unsubscribe();
      };
    },
    [machine, slot],
  );
  return useSyncExternalStore(subscribe, () =>
    toolActor(machine, slot)?.getSnapshot(),
  );
}
