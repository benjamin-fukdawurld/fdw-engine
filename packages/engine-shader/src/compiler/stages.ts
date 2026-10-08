import type { Diagnostic } from '../graph/Diagnostic';
import type { NodeTypes } from '../graph/inference';
import type { GraphNode, NodeId, PortRef } from '../graph/MaterialGraphData';
import type { ResolvedNode } from '../graph/validateGraph';
import { ShaderType, typeToString } from '../types/ShaderType';
import type { WorkingGraph } from './WorkingGraph';

/** When a value is computed, from the cheapest to the most expensive. */
export const Frequency = {
  Constant: 0,
  /** Once per draw: uniforms, textures, engine values. */
  Uniform: 1,
  /** Once per vertex. */
  Vertex: 2,
  /** Once per pixel. */
  Fragment: 3,
} as const;
export type Frequency = (typeof Frequency)[keyof typeof Frequency];

export interface StageVariablePlan {
  readonly name: string;
  readonly type: ShaderType;
  readonly location: number;
}

export interface AttributePlan extends StageVariablePlan {
  readonly node: NodeId;
  readonly semantic: string;
}

export interface VaryingPlan extends StageVariablePlan {
  readonly source: PortRef;
  readonly interpolation: 'perspective' | 'flat';
}

export interface StagePlan {
  readonly vertex: ReadonlySet<NodeId>;
  readonly fragment: ReadonlySet<NodeId>;
  readonly attributes: readonly AttributePlan[];
  readonly varyings: readonly VaryingPlan[];
}

const fragmentBuiltins = new Set(['frag-coord', 'front-facing']);

function nodeFrequency(
  resolved: ResolvedNode,
  inputFrequencies: readonly Frequency[]
): Frequency {
  const { node, definition, params } = resolved;
  switch (definition.category) {
    case 'constant':
      return Frequency.Constant;
    case 'input':
      if (node.type === 'input.attribute') {
        return Frequency.Vertex;
      }
      if (node.type === 'light.current') {
        // The body of a light loop, which runs per fragment.
        return Frequency.Fragment;
      }
      if (node.type === 'input.builtin') {
        return fragmentBuiltins.has(params['builtin'] as string)
          ? Frequency.Fragment
          : Frequency.Vertex;
      }
      return Frequency.Uniform;
    default: {
      if (
        definition.stage?.(params) === 'fragment' &&
        definition.category !== 'output'
      ) {
        return Frequency.Fragment;
      }
      return Math.max(Frequency.Constant, ...inputFrequencies) as Frequency;
    }
  }
}

// Integers and floats can cross from the vertex to the fragment stage;
// booleans and matrices cannot.
function isVaryingType(type: ShaderType): boolean {
  return (
    (type.kind === 'scalar' || type.kind === 'vector') &&
    (type.scalar === 'f32' || type.scalar === 'i32' || type.scalar === 'u32')
  );
}

const standardSemantics = [
  'position',
  'normal',
  'color',
  'uv',
  'tangent',
  'joints',
  'weights',
];

const identifier = (text: string): string => {
  const cleaned = text.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
};

export function planStages({
  graph,
  nodes,
  order,
  types,
  maxVaryings,
  diagnostics,
}: {
  graph: WorkingGraph;
  nodes: ReadonlyMap<NodeId, ResolvedNode>;
  order: readonly NodeId[];
  types: ReadonlyMap<NodeId, NodeTypes>;
  maxVaryings: number;
  diagnostics: Diagnostic[];
}): StagePlan | undefined {
  const frequencies = new Map<NodeId, Frequency>();
  for (const id of order) {
    const inputs = graph
      .incoming(id)
      .map((edge) => frequencies.get(edge.from.node) ?? Frequency.Constant);
    frequencies.set(id, nodeFrequency(nodes.get(id) as ResolvedNode, inputs));
  }

  const findOutput = (type: string) =>
    [...graph.nodes.values()].find((node) => node.type === type)?.id as NodeId;
  const vertexOutput = findOutput('output.vertex');
  const fragmentOutput = findOutput('output.fragment');

  // The vertex stage computes everything the clip position depends on.
  const vertex = new Set<NodeId>();
  const addToVertex = (id: NodeId) => {
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.pop() as NodeId;
      if (vertex.has(current)) {
        continue;
      }
      vertex.add(current);
      pending.push(...graph.incoming(current).map((edge) => edge.from.node));
    }
  };
  for (const edge of graph.incoming(vertexOutput)) {
    if ((frequencies.get(edge.from.node) ?? 0) >= Frequency.Fragment) {
      diagnostics.push({
        severity: 'error',
        node: vertexOutput,
        port: edge.to.port,
        message: `depends on a value that is only available in the fragment stage (#${edge.from.node})`,
      });
      return undefined;
    }
  }
  addToVertex(vertexOutput);

  // The fragment stage computes its own values and recomputes the cheap
  // constant and uniform ones. Per-vertex values are computed as early as
  // possible, in the vertex stage, and interpolated through varyings.
  const fragment = new Set<NodeId>([fragmentOutput]);
  const varyingSources = new Map<string, PortRef>();
  const pending = [fragmentOutput];
  while (pending.length > 0) {
    const consumer = pending.pop() as NodeId;
    for (const edge of graph.incoming(consumer)) {
      const source = edge.from.node;
      const type = types.get(source)?.outputs[edge.from.port];
      if (
        frequencies.get(source) === Frequency.Vertex &&
        type &&
        isVaryingType(type)
      ) {
        varyingSources.set(`${source}:${edge.from.port}`, edge.from);
        addToVertex(source);
        continue;
      }
      if (!fragment.has(source)) {
        fragment.add(source);
        pending.push(source);
      }
    }
  }

  const position = new Map(order.map((id, index) => [id, index]));
  const usedNames = new Set<string>();
  const uniqueName = (base: string) => {
    let name = base;
    for (let i = 2; usedNames.has(name); i++) {
      name = `${base}${i}`;
    }
    usedNames.add(name);
    return name;
  };

  const attributes: AttributePlan[] = [...vertex]
    .map((id) => graph.nodes.get(id))
    .filter((node): node is GraphNode => node?.type === 'input.attribute')
    .map((node) => ({
      node: node.id,
      semantic: node.params['semantic'] as string,
      type: node.params['type'] as ShaderType,
    }))
    .sort((a, b) => {
      const rank = (semantic: string) => {
        const index = standardSemantics.indexOf(semantic);
        return index < 0 ? standardSemantics.length : index;
      };
      return (
        rank(a.semantic) - rank(b.semantic) ||
        a.semantic.localeCompare(b.semantic)
      );
    })
    .map((attribute, location) => ({
      ...attribute,
      name: uniqueName(`a_${identifier(attribute.semantic)}`),
      location,
    }));

  const varyings: VaryingPlan[] = [...varyingSources.values()]
    .sort(
      (a, b) =>
        (position.get(a.node) ?? 0) - (position.get(b.node) ?? 0) ||
        a.port.localeCompare(b.port)
    )
    .map((source, location) => {
      const node = graph.nodes.get(source.node);
      const type = types.get(source.node)?.outputs[source.port] as ShaderType;
      const base =
        node?.label ??
        (node?.type === 'input.attribute'
          ? (node.params['semantic'] as string)
          : `${node?.type.split('.').pop()}${
              source.port === 'result' ? '' : `_${source.port}`
            }`);
      return {
        source,
        type,
        location,
        name: uniqueName(`v_${identifier(base)}`),
        interpolation:
          type.kind === 'scalar' || type.kind === 'vector'
            ? type.scalar === 'f32'
              ? 'perspective'
              : 'flat'
            : 'perspective',
      };
    });

  if (varyings.length > maxVaryings) {
    diagnostics.push({
      severity: 'error',
      message: `the program needs ${
        varyings.length
      } varyings, but the backend supports ${maxVaryings} (${varyings
        .map((varying) => `${varying.name}: ${typeToString(varying.type)}`)
        .join(', ')})`,
    });
    return undefined;
  }

  return { vertex, fragment, attributes, varyings };
}
