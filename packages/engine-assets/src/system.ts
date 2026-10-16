import type { ResourceStore } from '@fdw/engine-resources';
import type { Scheduler, System } from '@fdw/engine-scene';

export interface ResourceSystemOptions {
  /** Milliseconds per frame for the changes (reloads), 2 by default; at least one is applied. */
  readonly budgetMs?: number;
}

/**
 * Applies the pending changes of a store once per frame, at the start of
 * the frame (the `begin` phase): reloaded resources swap between two
 * frames, never during a rendering.
 */
export function addResourceSystem(
  scheduler: Scheduler,
  store: ResourceStore,
  { budgetMs = 2 }: ResourceSystemOptions = {}
): System {
  return scheduler.add('resources', () => store.update(budgetMs), {
    phase: 'begin',
  });
}
