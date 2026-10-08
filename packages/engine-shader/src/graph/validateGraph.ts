import { ShaderType } from '../types/ShaderType';
import { Diagnostic } from './Diagnostic';
import { NodeTypes, resolveNodeTypes } from './inference';
import {
  GraphEdge,
  GraphNode,
  MaterialGraphData,
  NodeId,
  portKey,
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
  value: StaticValue
): string | undefined {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') {
        return `parameter "${name}" must be a string`;
      }
      if (schema.values && !schema.values.includes(value)) {
        return `parameter "${name}" must be one of ${schema.values
          .map((allowed) => `"${allowed}"`)
          .join(', ')}, got "${value}"`;
      }
      return undefined;
    case 'number':
      return typeof value === 'number'
        ? undefined
        : `parameter "${name}" must be a number`;
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `parameter "${name}" must be a boolean`;
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
  diagnostics: Diagnostic[]
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

  const schemas = definition.params ?? {};
  let paramsValid = true;
  for (const [name, schema] of Object.entries(schemas)) {
    const value = node.params[name] ?? schema.default;
    if (value === undefined) {
      if (schema.required) {
        diagnostics.push({
          severity: 'error',
          node: node.id,
          message: `missing required parameter "${name}"`,
        });
        paramsValid = false;
      }
      continue;
    }
    const error = checkParam(name, schema, value);
    if (error) {
      diagnostics.push({ severity: 'error', node: node.id, message: error });
      paramsValid = false;
    }
  }
  for (const name of Object.keys(node.params)) {
    if (!(name in schemas)) {
      diagnostics.push({
        severity: 'warning',
        node: node.id,
        message: `unknown parameter "${name}" for node type "${node.type}"`,
      });
    }
  }
  if (!paramsValid) {
    return undefined;
  }

  const params = resolveParams(definition, node.params);
  try {
    return {
      node,
      definition,
      params,
      inputs: definition.inputs(params),
      outputs: definition.outputs(params),
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
  outputs: readonly Pick<GraphNode, 'id' | 'type'>[]
): string | undefined {
  if (outputs.length === 0) {
    return 'the graph has no output node';
  }
  // A function graph: function.output nodes only.
  const functionOutputs = outputs.filter(
    (node) => node.type === 'function.output'
  );
  if (functionOutputs.length > 0) {
    return functionOutputs.length === outputs.length
      ? undefined
      : 'a function graph cannot have stage outputs: use only function.output nodes';
  }
  const types = outputs.map((node) => node.type).sort();
  if (
    (types.length === 1 && types[0] === 'output.surface') ||
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
      ', '
    )}): use either one output.surface, or one output.vertex and one output.fragment`;
}

// The inputs and the outputs of a function graph have distinct names.
function checkFunctionPorts(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  diagnostics: Diagnostic[]
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
  diagnostics: Diagnostic[]
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

// Kahn's algorithm. Returns undefined when the graph has a cycle, after
// reporting the nodes involved.
function topologicalOrder(
  nodes: ReadonlyMap<NodeId, ResolvedNode>,
  edges: readonly GraphEdge[],
  diagnostics: Diagnostic[]
): NodeId[] | undefined {
  const inDegree = new Map<NodeId, number>();
  const successors = new Map<NodeId, NodeId[]>();
  for (const id of nodes.keys()) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }
  for (const edge of edges) {
    inDegree.set(edge.to.node, (inDegree.get(edge.to.node) ?? 0) + 1);
    successors.get(edge.from.node)?.push(edge.to.node);
  }

  const ready = [...nodes.keys()].filter((id) => inDegree.get(id) === 0);
  const order: NodeId[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as NodeId;
    order.push(id);
    for (const successor of successors.get(id) ?? []) {
      const degree = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, degree);
      if (degree === 0) {
        ready.push(successor);
      }
    }
  }

  if (order.length < nodes.size) {
    const cycle = [...nodes.keys()].filter((id) => !order.includes(id));
    diagnostics.push({
      severity: 'error',
      message: `the graph has a cycle involving nodes ${cycle
        .map((id) => `#${id}`)
        .join(', ')}`,
    });
    return undefined;
  }
  return order;
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
  registry: NodeRegistry
): GraphValidation {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<NodeId, ResolvedNode>();
  const seenIds = new Set<NodeId>();

  for (const node of graph.nodes) {
    if (seenIds.has(node.id)) {
      diagnostics.push({
        severity: 'error',
        node: node.id,
        message: `duplicate node id "${node.id}"`,
      });
      continue;
    }
    seenIds.add(node.id);

    const resolved = resolveGraphNode(node, registry, diagnostics);
    if (resolved) {
      nodes.set(node.id, resolved);
    }
  }

  // Edges between ports that exist; the others are reported and ignored.
  const edges: GraphEdge[] = [];
  const connectedInputs = new Set<string>();
  for (const edge of graph.edges) {
    const edgeLabel = `edge ${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}`;
    if (!seenIds.has(edge.from.node) || !seenIds.has(edge.to.node)) {
      diagnostics.push({
        severity: 'error',
        message: `${edgeLabel} references an unknown node`,
      });
      continue;
    }
    const source = nodes.get(edge.from.node);
    const target = nodes.get(edge.to.node);
    if (!source || !target) {
      // The node itself is invalid and already reported.
      continue;
    }
    if (!source.outputs.some((port) => port.name === edge.from.port)) {
      diagnostics.push({
        severity: 'error',
        node: edge.from.node,
        port: edge.from.port,
        message: `${edgeLabel}: node type "${source.node.type}" has no output "${edge.from.port}"`,
      });
      continue;
    }
    if (!target.inputs.some((port) => port.name === edge.to.port)) {
      diagnostics.push({
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: `${edgeLabel}: node type "${target.node.type}" has no input "${edge.to.port}"`,
      });
      continue;
    }
    if (edge.swizzle !== undefined && !parseSwizzle(edge.swizzle)) {
      diagnostics.push({
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: `${edgeLabel}: invalid swizzle ".${edge.swizzle}"`,
      });
      continue;
    }
    const key = portKey(edge.to);
    if (connectedInputs.has(key)) {
      diagnostics.push({
        severity: 'error',
        node: edge.to.node,
        port: edge.to.port,
        message: 'an input can only receive one edge',
      });
      continue;
    }
    connectedInputs.add(key);
    edges.push(edge);
  }

  for (const resolved of nodes.values()) {
    for (const name of Object.keys(resolved.node.defaults ?? {})) {
      if (!resolved.inputs.some((port) => port.name === name)) {
        diagnostics.push({
          severity: 'warning',
          node: resolved.node.id,
          port: name,
          message: `default value for unknown input "${name}"`,
        });
      }
    }
  }

  checkResourceDeclarations(nodes, diagnostics);
  checkFunctionPorts(nodes, diagnostics);

  const outputError = checkOutputNodes(
    [...nodes.values()]
      .filter((resolved) => resolved.definition.category === 'output')
      .map((resolved) => resolved.node)
  );
  if (outputError) {
    diagnostics.push({ severity: 'error', message: outputError });
  }

  const types = new Map<NodeId, NodeTypes>();
  const order = topologicalOrder(nodes, edges, diagnostics) ?? [];
  const incoming = new Map<NodeId, GraphEdge[]>();
  for (const edge of edges) {
    incoming.set(edge.to.node, [...(incoming.get(edge.to.node) ?? []), edge]);
  }

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
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    nodes,
    order,
    types,
  };
}
