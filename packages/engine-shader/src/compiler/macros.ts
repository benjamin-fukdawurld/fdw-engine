import type { Diagnostic } from '../graph/Diagnostic';
import type { NodeTypes } from '../graph/inference';
import { isGraphFunction, registryWithFunctions } from '../graph/functions';
import type {
  GraphNode,
  MaterialGraphData,
  NodeId,
  StaticValue,
  ValueSource,
} from '../graph/MaterialGraphData';
import {
  isMacroDefinition,
  MacroContext,
  resolveParams,
} from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { composeSwizzles } from '../graph/swizzle';
import { ResolvedNode, validateGraph } from '../graph/validateGraph';
import type { ConstantValue } from '../types/ConstantValue';
import type { WorkingGraph } from './WorkingGraph';

// Macros can generate macros, and function graphs can call macros and other
// functions: expansion runs until none is left, within a bound against
// endless expansions.
const maxPasses = 32;

function expandMacro(
  graph: WorkingGraph,
  registry: NodeRegistry,
  resolved: ResolvedNode,
  types: NodeTypes,
  feature: (name: string) => StaticValue | undefined,
): void {
  const { node, definition, params } = resolved;
  if (!isMacroDefinition(definition)) {
    return;
  }

  const context: MacroContext = {
    node,
    params,
    ports: resolved.inputs,
    input: (port) => {
      const connected = graph.inputSource(node, port);
      if (connected) {
        return connected;
      }
      const schema = resolved.inputs.find((input) => input.name === port);
      return schema?.default === undefined
        ? undefined
        : { value: schema.default };
    },
    typeOf: (port) => types.inputs[port] ?? types.outputs[port],
    add: (type, nodeParams = {}, inputs = {}) => {
      const sources: Record<string, ValueSource | undefined> = {};
      for (const [port, value] of Object.entries(inputs)) {
        sources[port] =
          value === undefined ||
          (typeof value === 'object' && ('ref' in value || 'value' in value))
            ? (value as ValueSource | undefined)
            : { value: value as ConstantValue };
      }
      const id = graph.addNode(type, nodeParams, sources);
      const added = registry.require(type);
      const defaultPort = added.outputs(resolveParams(added, nodeParams), {
        registry,
      })[0]?.name;
      return (port = defaultPort) => ({ ref: { node: id, port } });
    },
    hasInput: (type, port) => {
      const target = registry.require(type);
      return target
        .inputs(resolveParams(target, {}), { registry })
        .some((input) => input.name === port);
    },
    feature,
  };

  const results = definition.expand(context);
  for (const output of resolved.outputs) {
    let source = results[output.name];
    if (!source) {
      throw new Error(
        `the macro gave no value for its output "${output.name}"`,
      );
    }
    if ('value' in source) {
      const id = graph.addNode('const.value', {
        type: types.outputs[output.name],
        value: source.value,
      });
      source = { ref: { node: id, port: 'value' } };
    }
    graph.redirectPort({ node: node.id, port: output.name }, source);
  }
  graph.removeNode(node.id);
}

// The source of an input of a node of a function graph.
function bodySource(
  body: MaterialGraphData,
  node: GraphNode,
  port: string,
): ValueSource | undefined {
  const edge = body.edges.find(
    (candidate) => candidate.to.node === node.id && candidate.to.port === port,
  );
  if (edge) {
    return edge.swizzle === undefined
      ? { ref: edge.from }
      : { ref: edge.from, swizzle: edge.swizzle };
  }
  const value = node.defaults?.[port];
  return value === undefined ? undefined : { value };
}

// The function graphs called by a function, directly or not, through the
// registry: a function among them calls itself.
function callChain(
  id: string,
  registry: NodeRegistry,
  chain: readonly string[] = [],
): string[] | undefined {
  if (chain.includes(id)) {
    return [...chain, id];
  }
  const definition = registry.get(id);
  if (!isGraphFunction(definition)) {
    return undefined;
  }
  const body = definition.implementation.graph;
  const bodyRegistry = registryWithFunctions(registry, body);
  for (const type of new Set(body.nodes.map((node) => node.type))) {
    const cycle = callChain(type, bodyRegistry, [...chain, id]);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

// Replaces a call of a function graph by a copy of the graph: its inputs
// read the values given to the call, its outputs replace those of the call.
function inlineFunction(
  graph: WorkingGraph,
  registry: NodeRegistry,
  resolved: ResolvedNode,
  types: NodeTypes,
): void {
  const { node, definition } = resolved;
  if (!isGraphFunction(definition)) {
    return;
  }
  const cycle = callChain(definition.id, registry);
  if (cycle) {
    throw new Error(`recursive function: ${cycle.join(' → ')}`);
  }
  const body = definition.implementation.graph;
  const validation = validateGraph(body, registryWithFunctions(registry, body));
  if (!validation.valid) {
    throw new Error(
      `invalid function graph: ${validation.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join('; ')}`,
    );
  }
  const bodyNodes = new Map(body.nodes.map((inner) => [inner.id, inner]));
  const copies = new Map<NodeId, NodeId>();

  // A source of the function graph, in the calling graph.
  const map = (source: ValueSource | undefined): ValueSource | undefined => {
    if (!source || 'value' in source) {
      return source;
    }
    const from = bodyNodes.get(source.ref.node) as GraphNode;
    if (from.type !== 'function.input') {
      return {
        ref: { node: copies.get(from.id) as NodeId, port: source.ref.port },
        ...(source.swizzle ? { swizzle: source.swizzle } : {}),
      };
    }
    const name = from.params['name'] as string;
    const schema = resolved.inputs.find((input) => input.name === name);
    let given: ValueSource | undefined =
      graph.inputSource(node, name) ??
      (schema?.default === undefined ? undefined : { value: schema.default });
    if (!given) {
      throw new Error(`input "${name}" is not connected`);
    }
    if ('value' in given) {
      const type = types.inputs[name];
      // Literals are floats where nothing else types them: those of
      // integer and boolean inputs keep their type in a constant node.
      const typed =
        (type?.kind === 'scalar' || type?.kind === 'vector') &&
        type.scalar !== 'f32' &&
        type.scalar !== 'f16';
      if (!source.swizzle && !typed) {
        return given;
      }
      // A literal cannot be swizzled: it becomes a constant node.
      given = {
        ref: {
          node: graph.addNode('const.value', {
            type: types.inputs[name],
            value: given.value,
          }),
          port: 'value',
        },
      };
    }
    const swizzle =
      given.swizzle && source.swizzle
        ? composeSwizzles(given.swizzle, source.swizzle)
        : (given.swizzle ?? source.swizzle);
    if (swizzle === undefined && (given.swizzle || source.swizzle)) {
      throw new Error(`invalid swizzle of input "${name}"`);
    }
    return { ref: given.ref, ...(swizzle ? { swizzle } : {}) };
  };

  for (const id of validation.order) {
    const inner = bodyNodes.get(id) as GraphNode;
    if (inner.type === 'function.input' || inner.type === 'function.output') {
      continue;
    }
    const ports = new Set([
      ...body.edges
        .filter((edge) => edge.to.node === id)
        .map((edge) => edge.to.port),
      ...Object.keys(inner.defaults ?? {}),
    ]);
    const inputs: Record<string, ValueSource | undefined> = {};
    for (const port of ports) {
      inputs[port] = map(bodySource(body, inner, port));
    }
    copies.set(
      id,
      graph.addNode(inner.type, inner.params, inputs, inner.label),
    );
  }

  for (const output of resolved.outputs) {
    const outputNode = body.nodes.find(
      (inner) =>
        inner.type === 'function.output' &&
        inner.params['name'] === output.name,
    ) as GraphNode;
    let source = map(bodySource(body, outputNode, 'value'));
    if (!source) {
      throw new Error(`output "${output.name}" has no value`);
    }
    if ('value' in source) {
      source = {
        ref: {
          node: graph.addNode('const.value', {
            type: types.outputs[output.name],
            value: source.value,
          }),
          port: 'value',
        },
      };
    }
    graph.redirectPort({ node: node.id, port: output.name }, source);
  }
  graph.removeNode(node.id);
}

/**
 * Replaces every macro node by the nodes it generates, and every call of a
 * function graph by a copy of the graph.
 */
export function expandMacros({
  graph,
  registry,
  feature,
  diagnostics,
}: {
  graph: WorkingGraph;
  registry: NodeRegistry;
  feature: (name: string) => StaticValue | undefined;
  diagnostics: Diagnostic[];
}): void {
  for (let pass = 0; pass < maxPasses; pass++) {
    const validation = validateGraph(graph.toData(), registry);
    if (!validation.valid) {
      diagnostics.push(
        ...validation.diagnostics.filter((d) => d.severity === 'error'),
      );
      return;
    }
    const macros: NodeId[] = validation.order.filter((id) => {
      const { definition } = validation.nodes.get(id) as ResolvedNode;
      return isMacroDefinition(definition) || isGraphFunction(definition);
    });
    if (macros.length === 0) {
      return;
    }
    for (const id of macros) {
      const resolved = validation.nodes.get(id) as ResolvedNode;
      graph.origin = graph.origins.get(id) ?? id;
      try {
        const types = validation.types.get(id) as NodeTypes;
        if (isGraphFunction(resolved.definition)) {
          inlineFunction(graph, registry, resolved, types);
        } else {
          expandMacro(graph, registry, resolved, types, feature);
        }
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          node: id,
          message: `${resolved.node.type}: ${(error as Error).message}`,
        });
        return;
      } finally {
        graph.origin = undefined;
      }
    }
  }
  diagnostics.push({
    severity: 'error',
    message: `macro expansion did not terminate after ${maxPasses} passes`,
  });
}
