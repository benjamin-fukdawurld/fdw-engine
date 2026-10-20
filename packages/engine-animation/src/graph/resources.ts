import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';
import type { AnimationGraphData } from './data';
import { parseAnimationGraph } from './validate';

/**
 * An animation graph read from its file (`hero.animation.json`), migrated
 * if older: `store.load(AnimationGraphType, uri)`.
 *
 * @group Animation graph
 */
export const AnimationGraphType =
  defineResourceType<AnimationGraphData>('animation-graph');

/**
 * The loader of the animation graphs, to register in a store.
 *
 * @group Animation graph
 */
export const animationGraphLoader: ResourceLoader<AnimationGraphData> = {
  type: AnimationGraphType,
  load: async (ctx) => parseAnimationGraph(await ctx.text()),
};
