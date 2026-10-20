import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';
import type { BehaviorGraphData } from './data';
import { parseBehaviorGraph } from './validate';

/**
 * A behavior graph read from its file (`guard.behavior.json`), migrated
 * if older: `store.load(BehaviorGraphType, uri)`.
 *
 * @group Behavior graph
 */
export const BehaviorGraphType =
  defineResourceType<BehaviorGraphData>('behavior-graph');

/**
 * The loader of the behavior graphs, to register in a store.
 *
 * @group Behavior graph
 */
export const behaviorGraphLoader: ResourceLoader<BehaviorGraphData> = {
  type: BehaviorGraphType,
  load: async (ctx) => parseBehaviorGraph(await ctx.text()),
};
