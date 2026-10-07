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
export class NodeRegistry {
  private readonly _definitions = new Map<string, NodeDefinition>();

  constructor(definitions: Iterable<NodeDefinition> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Registers a node type.
   *
   * @throws when another node type has the same id.
   */
  register(definition: NodeDefinition): this {
    if (this._definitions.has(definition.id)) {
      throw new Error(`Node type "${definition.id}" is already registered`);
    }
    this._definitions.set(definition.id, definition);
    return this;
  }

  /** Whether a node type is registered. */
  has(id: string): boolean {
    return this._definitions.has(id);
  }

  /** The node type with this id, if any. */
  get(id: string): NodeDefinition | undefined {
    return this._definitions.get(id);
  }

  /**
   * The node type with this id.
   *
   * @throws when there is none.
   */
  require(id: string): NodeDefinition {
    const definition = this._definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown node type "${id}"`);
    }
    return definition;
  }

  /** All the registered node types. */
  get definitions(): IterableIterator<NodeDefinition> {
    return this._definitions.values();
  }
}
