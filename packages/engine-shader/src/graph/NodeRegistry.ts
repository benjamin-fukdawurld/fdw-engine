import type { NodeDefinition } from './NodeDefinition';

export class NodeRegistry {
  private readonly _definitions = new Map<string, NodeDefinition>();

  constructor(definitions: Iterable<NodeDefinition> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: NodeDefinition): this {
    if (this._definitions.has(definition.id)) {
      throw new Error(`Node type "${definition.id}" is already registered`);
    }
    this._definitions.set(definition.id, definition);
    return this;
  }

  has(id: string): boolean {
    return this._definitions.has(id);
  }

  get(id: string): NodeDefinition | undefined {
    return this._definitions.get(id);
  }

  require(id: string): NodeDefinition {
    const definition = this._definitions.get(id);
    if (!definition) {
      throw new Error(`Unknown node type "${id}"`);
    }
    return definition;
  }

  get definitions(): IterableIterator<NodeDefinition> {
    return this._definitions.values();
  }
}
