import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';
import { parseGraph, type MaterialGraphData } from '@fdw/engine-shader';

/**
 * A material graph read from its file (`water.material.json`), migrated if
 * older: `store.load(MaterialGraphType, uri)`.
 */
export const MaterialGraphType =
  defineResourceType<MaterialGraphData>('material-graph');

/** The loader of the material graphs (installAssets registers it). */
export const materialGraphLoader: ResourceLoader<MaterialGraphData> = {
  type: MaterialGraphType,
  load: async (ctx) => parseGraph(await ctx.text()),
};
