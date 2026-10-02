import type { Diagnostic } from '../graph/Diagnostic';
import type { NodeTypes } from '../graph/inference';
import type {
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
import { ResolvedNode, validateGraph } from '../graph/validateGraph';
import type { ConstantValue } from '../types/ConstantValue';
import type { WorkingGraph } from './WorkingGraph';

// Macros can generate macros: expansion runs until no macro is left, within
// a bound against endless expansions.
const maxPasses = 32;

function expandMacro(
  graph: WorkingGraph,
  registry: NodeRegistry,
  resolved: ResolvedNode,
  types: NodeTypes,
  feature: (name: string) => StaticValue | undefined
): void {
  const { node, definition, params } = resolved;
  if (!isMacroDefinition(definition)) {
    return;
  }

  const context: MacroContext = {
    node,
    params,
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
      const defaultPort = added.outputs(resolveParams(added, nodeParams))[0]
        ?.name;
      return (port = defaultPort) => ({ ref: { node: id, port } });
    },
    hasInput: (type, port) => {
      const target = registry.require(type);
      return target
        .inputs(resolveParams(target, {}))
        .some((input) => input.name === port);
    },
    feature,
  };

  const results = definition.expand(context);
  for (const output of resolved.outputs) {
    let source = results[output.name];
    if (!source) {
      throw new Error(
        `the macro gave no value for its output "${output.name}"`
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

// Replaces every macro node by the nodes it generates.
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
        ...validation.diagnostics.filter((d) => d.severity === 'error')
      );
      return;
    }
    const macros: NodeId[] = validation.order.filter((id) =>
      isMacroDefinition((validation.nodes.get(id) as ResolvedNode).definition)
    );
    if (macros.length === 0) {
      return;
    }
    for (const id of macros) {
      const resolved = validation.nodes.get(id) as ResolvedNode;
      try {
        expandMacro(
          graph,
          registry,
          resolved,
          validation.types.get(id) as NodeTypes,
          feature
        );
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          node: id,
          message: `${resolved.node.type}: ${(error as Error).message}`,
        });
        return;
      }
    }
  }
  diagnostics.push({
    severity: 'error',
    message: `macro expansion did not terminate after ${maxPasses} passes`,
  });
}
