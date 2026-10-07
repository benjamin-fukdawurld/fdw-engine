import type { NodeTypes } from '../graph/inference';
import type { GraphNode, NodeId, PortRef } from '../graph/MaterialGraphData';
import { isFunctionDefinition, PortSchema } from '../graph/NodeDefinition';
import { swizzleType } from '../graph/swizzle';
import type { ResolvedNode } from '../graph/validateGraph';
import type { ConstantValue } from '../types/ConstantValue';
import { ShaderType, BuiltinTypes } from '../types/ShaderType';
import type {
  IrBuiltin,
  IrEntryPoint,
  IrInstruction,
  IrIntrinsic,
  IrOp,
  IrStageVariable,
  ShaderModuleIR,
  ValueId,
} from './ir';
import { engineValueLocations, uniformBlockName } from './layout';
import type { StagePlan } from './stages';
import type { WorkingGraph } from './WorkingGraph';

// Expands a literal to the representation of the IR: full component arrays
// for vectors and matrices.
function normalizeConstant(
  value: ConstantValue,
  type: ShaderType
): ConstantValue {
  if (typeof value !== 'number') {
    return value;
  }
  if (type.kind === 'vector') {
    return new Array(type.size).fill(value);
  }
  if (type.kind === 'matrix') {
    return new Array(type.columns * type.rows).fill(value);
  }
  return value;
}

const binaryOperators = { add: '+', sub: '-', mul: '*', div: '/' } as const;

class StageBuilder {
  readonly body: IrInstruction[] = [];
  private readonly _values = new Map<string, ValueId>();
  private _nextId = 1;

  constructor(
    private readonly _graph: WorkingGraph,
    private readonly _types: ReadonlyMap<NodeId, NodeTypes>,
    // Values read from a stage input instead of being computed: varyings in
    // the fragment stage.
    private readonly _stageInputs: ReadonlyMap<string, string>
  ) {}

  emit(
    type: ShaderType,
    op: IrOp,
    args: readonly ValueId[] = [],
    node?: GraphNode
  ): ValueId {
    const id = this._nextId++;
    this.body.push({
      id,
      type,
      op,
      args,
      ...(node?.label ? { name: node.label } : {}),
      ...(node ? { sourceNode: node.id } : {}),
    });
    return id;
  }

  define(ref: PortRef, value: ValueId): void {
    this._values.set(`${ref.node}:${ref.port}`, value);
  }

  // The value of an output port in this stage.
  value(ref: PortRef): { id: ValueId; type: ShaderType } {
    const key = `${ref.node}:${ref.port}`;
    const type = this._types.get(ref.node)?.outputs[ref.port] as ShaderType;
    let id = this._values.get(key);
    if (id === undefined) {
      const input = this._stageInputs.get(key);
      if (input === undefined) {
        throw new Error(
          `internal error: ${key} is not available in this stage`
        );
      }
      id = this.emit(type, { kind: 'load-input', input });
      this._values.set(key, id);
    }
    return { id, type };
  }

  // The value of an input of a node, converted to the type of the port.
  input(
    node: GraphNode,
    port: PortSchema,
    expected: ShaderType
  ): ValueId | undefined {
    const source = this._graph.inputSource(node, port.name);
    let value: { id: ValueId; type: ShaderType };

    if (source && 'ref' in source) {
      value = this.value(source.ref);
      if (source.swizzle) {
        const key = `${source.ref.node}:${source.ref.port}.${source.swizzle}`;
        const type = swizzleType(value.type, source.swizzle) as ShaderType;
        let id = this._values.get(key);
        if (id === undefined) {
          id = this.emit(
            type,
            { kind: 'swizzle', components: source.swizzle },
            [value.id]
          );
          this._values.set(key, id);
        }
        value = { id, type };
      }
    } else {
      const literal = source?.value ?? port.default;
      if (literal === undefined) {
        return undefined;
      }
      return this.emit(expected, {
        kind: 'constant',
        value: normalizeConstant(literal, expected),
      });
    }

    // Scalar splat, made explicit for the code generators.
    if (value.type.kind === 'scalar' && expected.kind === 'vector') {
      return this.emit(expected, { kind: 'construct' }, [value.id]);
    }
    return value.id;
  }
}

function translateNode(
  builder: StageBuilder,
  resolved: ResolvedNode,
  types: NodeTypes,
  results: Record<string, ValueId>
): void {
  const { node, definition, params, inputs } = resolved;
  const output = (
    port: string,
    type: ShaderType,
    op: IrOp,
    args: readonly ValueId[] = []
  ) =>
    builder.define({ node: node.id, port }, builder.emit(type, op, args, node));
  const inputValues = () =>
    inputs.map(
      (port) => builder.input(node, port, types.inputs[port.name]) as ValueId
    );

  switch (node.type) {
    case 'const.value': {
      const type = params['type'] as ShaderType;
      output('value', type, {
        kind: 'constant',
        value: normalizeConstant(params['value'] as ConstantValue, type),
      });
      return;
    }
    case 'const.pi':
      output('value', BuiltinTypes.f32, { kind: 'constant', value: Math.PI });
      return;
    case 'input.attribute':
      // Attributes are bound to their stage input by the caller.
      return;
    case 'input.uniform':
      output('value', types.outputs['value'], {
        kind: 'load-resource',
        binding: uniformBlockName(params['slot'] as string),
        member: params['name'] as string,
      });
      return;
    case 'input.engine': {
      const location = engineValueLocations[params['value'] as string];
      output('value', types.outputs['value'], {
        kind: 'load-resource',
        binding: uniformBlockName(location.slot),
        member: location.member,
      });
      return;
    }
    case 'input.texture':
    case 'input.sampler':
      output('value', types.outputs['value'], {
        kind: 'load-resource',
        binding: params['name'] as string,
      });
      return;
    case 'input.builtin':
      output('value', types.outputs['value'], {
        kind: 'load-builtin',
        builtin: params['builtin'] as IrBuiltin,
      });
      return;
    case 'output.vertex':
      results['clipPosition'] = inputValues()[0];
      return;
    case 'output.fragment':
      results['color'] = inputValues()[0];
      return;
  }

  if (
    !isFunctionDefinition(definition) ||
    definition.implementation.kind !== 'intrinsic'
  ) {
    throw new Error(
      `internal error: cannot translate node type "${node.type}"`
    );
  }
  const op = definition.implementation.op;
  const args = inputValues();
  const type = types.outputs['result'];
  switch (op) {
    case 'identity':
      // No instruction: the output is the input value.
      builder.define({ node: node.id, port: 'result' }, args[0]);
      return;
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
      output(
        'result',
        type,
        { kind: 'binary', operator: binaryOperators[op] },
        args
      );
      return;
    case 'construct':
    case 'convert':
    case 'select':
      output('result', type, { kind: op }, args);
      return;
    case 'texture-sample':
      output('result', type, { kind: 'sample' }, args);
      return;
    default:
      output(
        'result',
        type,
        { kind: 'intrinsic', name: op as IrIntrinsic },
        args
      );
  }
}

const clipPosition: IrStageVariable = {
  name: 'clipPosition',
  type: BuiltinTypes.vec4f,
  builtin: 'position',
};

export function generateIr({
  graph,
  nodes,
  order,
  types,
  plan,
}: {
  graph: WorkingGraph;
  nodes: ReadonlyMap<NodeId, ResolvedNode>;
  order: readonly NodeId[];
  types: ReadonlyMap<NodeId, NodeTypes>;
  plan: StagePlan;
}): ShaderModuleIR {
  // Vertex stage: attributes are its inputs.
  const attributeInputs = new Map(
    plan.attributes.map((attribute) => [
      `${attribute.node}:value`,
      attribute.name,
    ])
  );
  const vertex = new StageBuilder(graph, types, attributeInputs);
  const vertexResults: Record<string, ValueId> = {};
  for (const id of order) {
    if (plan.vertex.has(id)) {
      translateNode(
        vertex,
        nodes.get(id) as ResolvedNode,
        types.get(id) as NodeTypes,
        vertexResults
      );
    }
  }
  for (const varying of plan.varyings) {
    vertexResults[varying.name] = vertex.value(varying.source).id;
  }

  // Fragment stage: varyings are its inputs.
  const varyingInputs = new Map(
    plan.varyings.map((varying) => [
      `${varying.source.node}:${varying.source.port}`,
      varying.name,
    ])
  );
  const fragment = new StageBuilder(graph, types, varyingInputs);
  const fragmentResults: Record<string, ValueId> = {};
  for (const id of order) {
    if (plan.fragment.has(id)) {
      translateNode(
        fragment,
        nodes.get(id) as ResolvedNode,
        types.get(id) as NodeTypes,
        fragmentResults
      );
    }
  }

  const varyings: IrStageVariable[] = plan.varyings.map((varying) => ({
    name: varying.name,
    type: varying.type,
    location: varying.location,
    interpolation: varying.interpolation,
  }));

  const entryPoints: IrEntryPoint[] = [
    {
      stage: 'vertex',
      inputs: plan.attributes.map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        location: attribute.location,
      })),
      outputs: [clipPosition, ...varyings],
      body: vertex.body,
      results: vertexResults,
    },
    {
      stage: 'fragment',
      inputs: [clipPosition, ...varyings],
      outputs: [{ name: 'color', type: BuiltinTypes.vec4f, location: 0 }],
      body: fragment.body,
      results: fragmentResults,
    },
  ];

  return { name: graph.name, entryPoints };
}
