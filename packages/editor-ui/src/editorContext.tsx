import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react';
import type { EditorActor } from './state/editorMachine';
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
