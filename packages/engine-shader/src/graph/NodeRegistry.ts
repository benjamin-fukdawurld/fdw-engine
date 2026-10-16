import { Registry } from '@fdw/engine-graph';
import type { NodeDefinition } from './NodeDefinition';

/**
 * The node types available to graphs, by id.
 *
 * @example
 * ```ts
 * const registry = createStandardRegistry().register(myNodeType);
 * const g = new GraphBuilder('custom', registry);
 * compile(g.build(), { registry });
 * ```
 *
 * @group Node definitions
 */
export class NodeRegistry extends Registry<NodeDefinition> {}
