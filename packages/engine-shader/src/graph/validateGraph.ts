import {
  basicParamCheck,
  checkDefaults,
  checkParams,
  hasNoError,
  incomingEdges,
  resolveEdges,
  resolveNodes,
  topologicalOrder,
} from '@fdw/engine-graph';
import { ShaderType } from '../types/ShaderType';
import { Diagnostic } from './Diagnostic';
import { NodeTypes, resolveNodeTypes } from './inference';
import {
  GraphNode,
  MaterialGraphData,
  NodeId,
  StaticValue,
} from './MaterialGraphData';
import {
  NodeDefinition,
  ParamSchema,
  PortSchema,
  resolveParams,
  StaticParams,
} from './NodeDefinition';
import { NodeRegistry } from './NodeRegistry';
import { parseSwizzle, swizzleType } from './swizzle';

/**
 * A node with its definition, resolved parameters and ports.
 *
 * @group Validation
 */
export interface ResolvedNode {
  readonly node: GraphNode;
  readonly definition: NodeDefinition;
  readonly params: StaticParams;
  readonly inputs: readonly PortSchema[];
  readonly outputs: readonly PortSchema[];
}

/**
 * Result of {@link validateGraph}.
 *
 * @group Validation
 */
export interface GraphValidation {
  /** True when no diagnostic is an error. */
  readonly valid: boolean;
  /** Errors and warnings. */
  readonly diagnostics: readonly Diagnostic[];
  /** The nodes that could be resolved. */
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  /** Topological order of the nodes; empty when the graph has a cycle. */
  readonly order: readonly NodeId[];
  /** Concrete port types of the nodes whose types could be resolved. */
  readonly types: ReadonlyMap<NodeId, NodeTypes>;
}

const shaderTypeKinds = new Set([
  'scalar',
  'vector',
  'matrix',
  'array',
  'struct',
  'texture',
  'sampler',
]);

function isShaderTypeValue(value: StaticValue): value is ShaderType {
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    shaderTypeKinds.has((value as ShaderType).kind)
  );
}

function checkParam(
  name: string,
  schema: ParamSchema,
  value: StaticValue,
): string | undefined {
  switch (schema.kind) {
    case 'type':
      return isShaderTypeValue(value)
        ? undefined
        : `parameter "${name}" must be a shader type`;
    case 'constant':
      return typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) && value.every((v) => typeof v === 'number'))
        ? undefined
        : `parameter "${name}" must be a number, a boolean or an array of numbers`;
    default:
      return basicParamCheck(name, schema, value);
  }
}

/**
 * Checks the parameters of a node and resolves its ports. Problems are added
 * to `diagnostics`; returns undefined when the node cannot be resolved.
 *
 * @group Validation
 */
export function resolveGraphNode(
  node: GraphNode,
  registry: NodeRegistry,
  diagnostics: Diagnostic[],
): ResolvedNode | undefined {
  const definition = registry.get(node.type);
  if (!definition) {
    diagnostics.push({
      severity: 'error',
      node: node.id,
      message: `unknown node type "${node.type}"`,
    });
    return undefined;
  }

  const paramsValid = checkParams(
    node,
    definition.params ?? {},
    (name, schema, value) => checkParam(name, schema, value as StaticValue),
    diagnostics,
  );
  if (!paramsValid) {
    return undefined;
  }

  const params = resolveParams(definition, node.params);
  try {
    return {
      node,
      definition,
      params,
      inputs: definition.inputs(params, { registry }),
      outputs: definition.outputs(params, { registry }),
    };
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      node: node.id,
      message: `cannot resolve the ports: ${(error as Error).message}`,
    });
    return undefined;
  }
}

/**
 * A graph ends either with one 'output.surface', or with one 'output.vertex'
 * and one 'output.fragment' for full control over the stages.
 *
 * @group Validation
 */
export function checkOutputNodes(
  outputs: readonly Pick<GraphNode, 'id' | 'type'>[],
): string | undefined {
  if (outputs.length === 0) {
    return 'the graph has no output node';
  }
  // A compute graph: one output.compute, and write.storage nodes.
  const computes = outputs.filter((node) => node.type === 'output.compute');
  const writes = outputs.filter((node) => node.type === 'write.storage');
  if (computes.length > 0 || writes.length > 0) {
    if (computes.length !== 1) {
      return computes.length === 0
        ? 'write.storage nodes belong to a compute graph: add an output.compute node'
        : 'a compute graph has a single output.compute node';
    }
    return computes.length + writes.length === outputs.length
      ? undefined
      : 'a compute graph has no other outputs than output.compute and write.storage';
  }
  // Attributes computed by the graph, with a surface or the raw stages.
  const attributes = outputs.filter((node) => node.type === 'output.attribute');
  if (attributes.length > 0) {
    const others = outputs.filter((node) => node.type !== 'output.attribute');
    if (
      others.some(
        (node) =>
          node.type === 'output.fullscreen' || node.type === 'function.output',
      )
    ) {
      return 'output.attribute nodes belong to graphs ending with output.surface, or with output.vertex and output.fragment';
    }
    return checkOutputNodes(others);
  }
  // The values of a material for its scene outputs, with a surface.
  const values = outputs.filter((node) => node.type === 'output.value');
  if (values.length > 0) {
    const others = outputs.filter((node) => node.type !== 'output.value');
    return others.length === 1 && others[0].type === 'output.surface'
      ? undefined
      : 'output.value nodes belong to graphs ending with output.surface';
  }
  // Extra color targets, with the raw stages or a full screen pass.
  const targets = outputs.filter((node) => node.type === 'output.target');
  if (targets.length > 0) {
    const others = outputs.filter((node) => node.type !== 'output.target');
    const kinds = others.map((node) => node.type).sort();
    const withStages =
      (kinds.length === 2 &&
        kinds[0] === 'output.fragment' &&
        kinds[1] === 'output.vertex') ||
      (kinds.length === 1 && kinds[0] === 'output.fullscreen');
    return withStages
      ? undefined
      : 'output.target nodes belong to graphs ending with output.vertex and output.fragment, or with output.fullscreen';
  }
  // A function graph: function.output nodes only.
  const functionOutputs = outputs.filter(
    (node) => node.type === 'function.output',
  );
  if (functionOutputs.length > 0) {
    return functionOutputs.length === outputs.length
      ? undefined
      : 'a function graph cannot have stage outputs: use only function.output nodes';
  }
  const types = outputs.map((node) => node.type).sort();
  if (
    (types.length === 1 &&
      (types[0] === 'output.surface' || types[0] === 'output.fullscreen')) ||
    (types.length === 2 &&
      types[0] === 'output.fragment' &&
      types[1] === 'output.vertex')
  ) {
    return undefined;
  }
  if (types.length === 1) {
    const missing =
      types[0] === 'output.vertex' ? 'output.fragment' : 'output.vertex';
    return `the graph has a ${types[0]} node but no ${missing} node`;
  }
  return `the graph has ${outputs.length} output nodes (${outputs
    .map((node) => `#${node.id} ${node.type}`)
    .join(
      ', ',
    )}): use either one output.surface, or one output.vertex and one output.fragment`;
}

// The inputs and the outputs of a function graph have distinct names.
function checkFunctionPorts(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  diagnostics: Diagnostic[],
): void {
  for (const type of ['function.input', 'function.output']) {
    const names = new Set<string>();
    for (const { node, params } of nodes.values()) {
      if (node.type !== type) {
        continue;
      }
      const name = params['name'] as string;
      if (names.has(name)) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `duplicate ${type} "${name}"`,
        });
      }
      names.add(name);
    }
  }
}

// Uniforms, storage buffers, textures and samplers become named bindings:
// nodes using the same name must declare the same resource. The uniform
// default value is not part of the declaration.
const resourceNodeTypes = new Set([
  'input.uniform',
  'input.storage',
  'input.texture',
  'input.sampler',
]);

function checkResourceDeclarations(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  diagnostics: Diagnostic[],
): void {
  const declarations = new Map<string, { id: NodeId; signature: string }>();
  const attributes = new Map<string, { id: NodeId; signature: string }>();

  for (const resolved of nodes.values()) {
    const { node, params } = resolved;
    if (node.type === 'input.attribute') {
      const semantic = params['semantic'] as string;
      const signature = JSON.stringify(params['type']);
      const first = attributes.get(semantic);
      if (!first) {
        attributes.set(semantic, { id: node.id, signature });
      } else if (first.signature !== signature) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `attribute "${semantic}" is declared with different types (see #${first.id})`,
        });
      }
      continue;
    }
    if (!resourceNodeTypes.has(node.type)) {
      continue;
    }

    const name = params['name'] as string;
    const { default: _default, ...declaration } = params;
    void _default;
    const signature = JSON.stringify({ type: node.type, ...declaration });
    const first = declarations.get(name);
    if (!first) {
      declarations.set(name, { id: node.id, signature });
    } else if (first.signature !== signature) {
      diagnostics.push({
        severity: 'error',
        node: node.id,
        message: `resource "${name}" is declared differently by #${first.id}`,
      });
    }
  }
}

/**
 * Validates a graph: node types and parameters, edges and swizzles, cycles,
 * output nodes, resource declarations and types. Returns the topological
 * order and the port types, for the compiler.
 *
 * Unlike {@link GraphBuilder.build} and {@link compile}, it does not throw:
 * the problems are in `diagnostics`.
 *
 * @group Validation
 */
export function validateGraph(
  graph: MaterialGraphData,
  registry: NodeRegistry,
): GraphValidation {
  const diagnostics: Diagnostic[] = [];
  const { seen, resolved: nodes } = resolveNodes(
    graph.nodes,
    (node) => resolveGraphNode(node, registry, diagnostics),
    diagnostics,
  );

  // Edges between ports that exist; the others are reported and ignored.
  const edges = resolveEdges(
    graph.edges,
    seen,
    nodes,
    diagnostics,
    (edge, label) =>
      edge.swizzle !== undefined && !parseSwizzle(edge.swizzle)
        ? {
            severity: 'error',
            node: edge.to.node,
            port: edge.to.port,
            message: `${label}: invalid swizzle ".${edge.swizzle}"`,
          }
        : undefined,
  );
  checkDefaults(nodes.values(), diagnostics);

  checkResourceDeclarations(nodes, diagnostics);
  checkFunctionPorts(nodes, diagnostics);

  const outputError = checkOutputNodes(
    [...nodes.values()]
      .filter((resolved) => resolved.definition.category === 'output')
      .map((resolved) => resolved.node),
  );
  if (outputError) {
    diagnostics.push({ severity: 'error', message: outputError });
  }

  const types = new Map<NodeId, NodeTypes>();
  const order = topologicalOrder(nodes.keys(), edges, diagnostics) ?? [];
  const incoming = incomingEdges(edges);

  for (const id of order) {
    const resolved = nodes.get(id) as ResolvedNode;
    const connected: Record<string, ShaderType> = {};
    let upstreamUnknown = false;

    for (const edge of incoming.get(id) ?? []) {
      const sourceType = types.get(edge.from.node)?.outputs[edge.from.port];
      if (!sourceType) {
        // The source could not be typed: already reported upstream.
        upstreamUnknown = true;
        continue;
      }
      if (edge.swizzle === undefined) {
        connected[edge.to.port] = sourceType;
        continue;
      }
      const swizzled = swizzleType(sourceType, edge.swizzle);
      if (typeof swizzled === 'string') {
        diagnostics.push({
          severity: 'error',
          node: id,
          port: edge.to.port,
          message: swizzled,
        });
        upstreamUnknown = true;
        continue;
      }
      connected[edge.to.port] = swizzled;
    }

    /**
     * Typing a node whose inputs are partly unknown would only produce
     * cascading errors.
     */
    if (upstreamUnknown) {
      continue;
    }

    const resolution = resolveNodeTypes({
      inputs: resolved.inputs,
      outputs: resolved.outputs,
      connected,
      defaults: resolved.node.defaults,
    });
    for (const error of resolution.errors) {
      diagnostics.push({
        severity: 'error',
        node: id,
        port: error.port,
        message: error.message,
      });
    }
    if (resolution.errors.length === 0) {
      types.set(id, resolution.types);
    }
  }

  return {
    valid: hasNoError(diagnostics),
    diagnostics,
    nodes,
    order,
    types,
  };
}
