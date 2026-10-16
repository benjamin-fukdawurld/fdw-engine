/**
 * The node types available to a kind of graph, by id.
 *
 * @example
 * ```ts
 * const registry = new Registry([clipNode, blendNode]);
 * registry.require('anim.clip');
 * ```
 *
 * @group Node types
 */
export class Registry<D extends { readonly id: string }> {
  private readonly _definitions = new Map<string, D>();

  constructor(definitions: Iterable<D> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Registers a node type.
   *
   * @throws when another node type has the same id.
   */
  register(definition: D): this {
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
  get(id: string): D | undefined {
    return this._definitions.get(id);
  }

  /**
   * The node type with this id.
   *
   * @throws when there is none.
   */
  require(id: string): D {
    const definition = this._definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown node type "${id}"`);
    }
    return definition;
  }

  /** All the registered node types. */
  get definitions(): IterableIterator<D> {
    return this._definitions.values();
  }
}
