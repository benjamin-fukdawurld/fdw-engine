import { GraphError } from './Diagnostic';
import type { MaterialGraphData } from './MaterialGraphData';
import {
  FunctionDefinition,
  isFunctionDefinition,
  NodeDefinition,
  PortSchema,
} from './NodeDefinition';
import { NodeRegistry } from './NodeRegistry';
import { validateGraph } from './validateGraph';
import { createStandardRegistry } from '../std';
import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

/**
 * Whether a node type is a function defined by a graph.
 *
 * @group Functions
 */
export function isGraphFunction(
  definition: NodeDefinition | undefined,
): definition is FunctionDefinition & {
  readonly implementation: { readonly kind: 'graph' };
} {
  return (
    definition !== undefined &&
    isFunctionDefinition(definition) &&
    definition.implementation?.kind === 'graph'
  );
}

/**
 * A registry with the functions embedded in a graph (its `functions`
 * section, and theirs), dependencies first. Returns the registry itself when
 * there is nothing to add. Functions already registered are kept.
 *
 * @group Functions
 */
export function registryWithFunctions(
  registry: NodeRegistry,
  graph: MaterialGraphData,
): NodeRegistry {
  if (!graph.functions?.length) {
    return registry;
  }
  const extended = new NodeRegistry(registry.definitions);
  const add = (functions: MaterialGraphData['functions']) => {
    for (const { id, description, graph: body } of functions ?? []) {
      if (extended.has(id)) {
        continue;
      }
      add(body.functions);
      if (extended.has(id)) {
        continue;
      }
      extended.register(
        defineFunction(body, { id, description, registry: extended }),
      );
    }
  };
  add(graph.functions);
  return extended;
}

/**
 * Makes a node type of a function graph: a graph whose `function.input` nodes
 * are the inputs of the node, and whose `function.output` nodes are its
 * outputs. The compiler inlines the graph at each call.
 *
 * @throws {@link GraphError} when the graph is not a valid function graph.
 *
 * @example
 * ```ts
 * const f = new GraphBuilder('fresnel');
 * const cosine = f.functionInput('cosine', BuiltinTypes.f32);
 * const f0 = f.functionInput('f0', BuiltinTypes.vec3f, { default: 0.04 });
 * f.functionOutput('result', … );
 * const fresnel = defineFunction(f.build(), { id: 'my.fresnel' });
 *
 * g.call(fresnel, { cosine: nDotV });
 * ```
 *
 * @group Functions
 */
export function defineFunction(
  graph: MaterialGraphData,
  {
    id,
    description,
    registry = createStandardRegistry(),
  }: { id: string; description?: string; registry?: NodeRegistry },
): FunctionDefinition {
  const validation = validateGraph(
    graph,
    registryWithFunctions(registry, graph),
  );
  if (!validation.valid) {
    throw new GraphError(validation.diagnostics);
  }
  const inputs: PortSchema[] = [];
  const outputs: PortSchema[] = [];
  for (const node of graph.nodes) {
    const name = node.params['name'] as string;
    if (node.type === 'function.input') {
      const value = node.params['default'] as ConstantValue | undefined;
      inputs.push({
        name,
        type: node.params['type'] as ShaderType,
        ...(value === undefined ? {} : { default: value }),
      });
    } else if (node.type === 'function.output') {
      outputs.push({
        name,
        type: validation.types.get(node.id)?.inputs['value'] as ShaderType,
      });
    }
  }
  if (outputs.length === 0) {
    throw new GraphError([
      {
        severity: 'error',
        message: `function "${id}" has no function.output node`,
      },
    ]);
  }
  return {
    id,
    category: 'function',
    ...(description ? { description } : {}),
    implementation: { kind: 'graph', graph },
    inputs: () => inputs,
    outputs: () => outputs,
  };
}
