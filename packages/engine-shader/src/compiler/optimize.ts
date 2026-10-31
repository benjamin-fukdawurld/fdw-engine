import type { NodeTypes } from '../graph/inference';
import type { GraphNode, NodeId } from '../graph/MaterialGraphData';
import {
  isFunctionDefinition,
  IntrinsicOp,
  resolveParams,
} from '../graph/NodeDefinition';
import type { NodeRegistry } from '../graph/NodeRegistry';
import { parseSwizzle } from '../graph/swizzle';
import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';
import { stableStringify } from './hash';
import type { WorkingGraph } from './WorkingGraph';

const rootTypes = new Set([
  'output.vertex',
  'output.fragment',
  'output.target',
  'output.compute',
  'write.storage',
]);

const loopSources = new Set(['loop.state', 'loop.index']);

/** Removes the nodes that do not contribute to the stage outputs. */
export function eliminateDeadCode(graph: WorkingGraph): void {
  const live = new Set<NodeId>();
  const pending = [...graph.nodes.values()]
    .filter((node) => rootTypes.has(node.type))
    .map((node) => node.id);

  while (pending.length > 0) {
    const id = pending.pop() as NodeId;
    if (live.has(id)) {
      continue;
    }
    live.add(id);
    for (const edge of graph.incoming(id)) {
      pending.push(edge.from.node);
    }
  }

  for (const id of [...graph.nodes.keys()]) {
    if (!live.has(id)) {
      graph.removeNode(id);
    }
  }
}

// --- Constant folding --------------------------------------------------------

// Only f32 scalars and vectors are folded: integer division and overflow do
// not behave as in JavaScript, and matrices are out of scope for now.
const componentCount = (type: ShaderType): number | undefined => {
  if (type.kind === 'scalar' && type.scalar === 'f32') {
    return 1;
  }
  if (type.kind === 'vector' && type.scalar === 'f32') {
    return type.size;
  }
  return undefined;
};

const componentWise =
  (fn: (...values: number[]) => number) => (inputs: number[][]) =>
    inputs[0].map((_, i) => fn(...inputs.map((input) => input[i])));

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

const evaluators: Partial<
  Record<IntrinsicOp, (inputs: number[][]) => number[]>
> = {
  add: componentWise((a, b) => a + b),
  sub: componentWise((a, b) => a - b),
  mul: componentWise((a, b) => a * b),
  div: componentWise((a, b) => a / b),
  min: componentWise(Math.min),
  max: componentWise(Math.max),
  abs: componentWise(Math.abs),
  floor: componentWise(Math.floor),
  fract: componentWise((x) => x - Math.floor(x)),
  sqrt: componentWise(Math.sqrt),
  log2: componentWise(Math.log2),
  exp2: componentWise((x) => 2 ** x),
  acos: componentWise(Math.acos),
  atan2: componentWise(Math.atan2),
  sin: componentWise(Math.sin),
  cos: componentWise(Math.cos),
  saturate: componentWise((x) => Math.min(Math.max(x, 0), 1)),
  pow: componentWise(Math.pow),
  step: componentWise((edge, x) => (x < edge ? 0 : 1)),
  identity: ([value]) => value,
  mix: componentWise((a, b, t) => a + (b - a) * t),
  clamp: componentWise((x, low, high) => Math.min(Math.max(x, low), high)),
  smoothstep: componentWise((low, high, x) => {
    const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
    return t * t * (3 - 2 * t);
  }),
  dot: ([a, b]) => [sum(a.map((value, i) => value * b[i]))],
  length: ([x]) => [Math.sqrt(sum(x.map((value) => value * value)))],
  normalize: ([x]) => {
    const length = Math.sqrt(sum(x.map((value) => value * value)));
    return x.map((value) => value / length);
  },
  cross: ([a, b]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  construct: (inputs) => inputs.flat(),
};

// Components of a literal for a type, expanding scalar splats.
function literalComponents(
  value: ConstantValue,
  count: number,
): number[] | undefined {
  if (typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return new Array(count).fill(value);
  }
  return value.length === count ? [...value] : undefined;
}

// Constant components feeding an input, or undefined when the input is not
// constant.
function constantInput(
  graph: WorkingGraph,
  node: GraphNode,
  port: string,
  portDefault: ConstantValue | undefined,
  count: number,
): number[] | undefined {
  const source = graph.inputSource(node, port);
  if (!source) {
    return portDefault === undefined
      ? undefined
      : literalComponents(portDefault, count);
  }
  if ('value' in source) {
    return literalComponents(source.value, count);
  }

  const sourceNode = graph.nodes.get(source.ref.node);
  let components: number[] | undefined;
  if (sourceNode?.type === 'const.value') {
    const type = sourceNode.params['type'] as ShaderType;
    const sourceCount = componentCount(type);
    components =
      sourceCount === undefined
        ? undefined
        : literalComponents(
            sourceNode.params['value'] as ConstantValue,
            sourceCount,
          );
  } else if (sourceNode?.type === 'const.pi') {
    components = [Math.PI];
  }
  if (!components) {
    return undefined;
  }

  if (source.swizzle) {
    const unswizzled = components;
    components = (parseSwizzle(source.swizzle) as number[]).map(
      (i) => unswizzled[i],
    );
  }
  // Scalar splat to the type of the input.
  return components.length === 1 && count > 1
    ? new Array(count).fill(components[0])
    : components;
}

// Replaces a function node whose inputs are all constant by a constant.
function foldNode(
  graph: WorkingGraph,
  node: GraphNode,
  registry: NodeRegistry,
  types: NodeTypes | undefined,
): void {
  const definition = registry.get(node.type);
  if (
    !types ||
    !definition ||
    !isFunctionDefinition(definition) ||
    definition.implementation.kind !== 'intrinsic'
  ) {
    return;
  }
  const evaluate = evaluators[definition.implementation.op];
  const outputType = types.outputs['result'];
  if (!evaluate || !outputType || componentCount(outputType) === undefined) {
    return;
  }

  const ports = definition.inputs(resolveParams(definition, node.params));
  const inputs: number[][] = [];
  for (const port of ports) {
    const type = types.inputs[port.name];
    const count = type && componentCount(type);
    if (count === undefined) {
      return;
    }
    const components = constantInput(
      graph,
      node,
      port.name,
      port.default,
      count,
    );
    if (!components) {
      return;
    }
    inputs.push(components);
  }

  const result = evaluate(inputs).map(Math.fround);
  if (!result.every(Number.isFinite)) {
    // Division by zero and friends are left to the GPU.
    return;
  }

  graph.removeIncoming(node.id);
  graph.redirectPort(
    { node: node.id, port: 'result' },
    { ref: { node: node.id, port: 'value' } },
  );
  graph.nodes.set(node.id, {
    id: node.id,
    type: 'const.value',
    params: {
      type: outputType,
      value: result.length === 1 ? result[0] : result,
    },
    ...(node.label ? { label: node.label } : {}),
  });
}

// --- Common subexpression elimination -----------------------------------------

/**
 * The parameters that define what a node computes. The default value of a
 * uniform is only its initial value on new materials: it is not part of the
 * program, so that materials differing by their values share it.
 */
export function structuralParams(node: GraphNode): GraphNode['params'] {
  if (node.type !== 'input.uniform') {
    return node.params;
  }
  const { default: _default, ...params } = node.params;
  void _default;
  return params;
}

// Two nodes with the same type, parameters and inputs compute the same value.
function nodeKey(graph: WorkingGraph, node: GraphNode): string {
  const inputs = graph
    .incoming(node.id)
    .map(
      (edge) =>
        `${edge.to.port}=${edge.from.node}.${edge.from.port}.${
          edge.swizzle ?? ''
        }`,
    )
    .sort();
  return stableStringify([
    node.type,
    structuralParams(node),
    node.defaults ?? {},
    inputs,
  ]);
}

export function optimize(
  graph: WorkingGraph,
  registry: NodeRegistry,
  order: readonly NodeId[],
  types: ReadonlyMap<NodeId, NodeTypes>,
): void {
  eliminateDeadCode(graph);

  // In topological order, so that the inputs of a node are already folded
  // and deduplicated when the node is processed.
  const canonical = new Map<string, NodeId>();
  for (const id of order) {
    const node = graph.nodes.get(id);
    if (!node) {
      continue;
    }
    foldNode(graph, node, registry, types.get(id));

    const current = graph.nodes.get(id) as GraphNode;
    // The state and the index of each loop are its own, however alike.
    if (rootTypes.has(current.type) || loopSources.has(current.type)) {
      continue;
    }
    const key = nodeKey(graph, current);
    const existing = canonical.get(key);
    if (existing === undefined) {
      canonical.set(key, id);
    } else {
      graph.redirectUses(id, existing);
      graph.removeNode(id);
    }
  }

  eliminateDeadCode(graph);
}
