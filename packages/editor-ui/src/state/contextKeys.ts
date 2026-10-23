import type { IDisposable } from './services';
import { matchesWhen, type ContextKeyValues } from './when';

/** What the context keys are derived from: a store, a machine. */
export interface ContextKeySource {
  subscribe(listener: () => void): { unsubscribe(): void };
}

/**
 * The context keys of the editor (design/editor-state.md §7): derived from
 * its state, for the `when` clauses, so that a plugin reads a computed
 * context without knowing the machine. A plugin may set keys of its own.
 */
export interface ContextKeys {
  /** The values; the same object until one changes. */
  values(): ContextKeyValues;
  /** Listens to the changes of the values; returns the unsubscription. */
  subscribe(listener: () => void): () => void;
  /** Sets a key over the derived ones, until disposed. */
  set(key: string, value: unknown): IDisposable;
  /** Whether the values satisfy the clause; true without one. */
  matches(when: string | undefined): boolean;
}

function sameValues(a: ContextKeyValues, b: ContextKeyValues): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
}

/** The context keys derived by `derive`, computed again when a source changes. */
export function createContextKeys(
  sources: readonly ContextKeySource[],
  derive: () => ContextKeyValues,
): ContextKeys & IDisposable {
  const listeners = new Set<() => void>();
  // Several sets of a key: the last one wins, until disposed.
  const set: { readonly key: string; readonly value: unknown }[] = [];
  const compute = (): ContextKeyValues => ({
    ...derive(),
    ...Object.fromEntries(set.map(({ key, value }) => [key, value])),
  });
  let values = compute();
  const update = () => {
    const next = compute();
    if (sameValues(values, next)) return;
    values = next;
    for (const listener of [...listeners]) listener();
  };
  const subscriptions = sources.map((source) => source.subscribe(update));
  return {
    values: () => values,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (key, value) => {
      const entry = { key, value };
      set.push(entry);
      update();
      return {
        dispose: () => {
          const index = set.indexOf(entry);
          if (index < 0) return;
          set.splice(index, 1);
          update();
        },
      };
    },
    matches: (when) => matchesWhen(when, values),
    dispose: () => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      listeners.clear();
    },
  };
}
