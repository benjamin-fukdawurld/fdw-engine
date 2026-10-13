import type { NodeTypes } from '../graph/inference';
import type { GraphNode, NodeId, PortRef } from '../graph/MaterialGraphData';
import { isFunctionDefinition, PortSchema } from '../graph/NodeDefinition';
import { swizzleType } from '../graph/swizzle';
import type { ResolvedNode } from '../graph/validateGraph';
import type { ConstantValue } from '../types/ConstantValue';
import { BuiltinTypes, ShaderType } from '../types/ShaderType';
import type {
  IrBuiltin,
  IrEntryPoint,
  IrInstruction,
  IrIntrinsic,
  IrOp,
  IrStageVariable,
  IrWrite,
  ShaderModuleIR,
  ValueId,
} from './ir';
import {
  engineResources,
  engineValueLocations,
  lightArrayType,
  lightMembers,
  uniformBlockName,
} from './layout';
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

const comparisons = {
  less: '<',
  'less-equal': '<=',
  greater: '>',
  'greater-equal': '>=',
  equal: '==',
  'not-equal': '!=',
} as const;

class StageBuilder {
  readonly body: IrInstruction[] = [];
  // Instructions and values of the scopes being built: the stage, then the
  // bodies of the loops. Values of a scope are visible in the nested ones.
  private readonly _bodies: IrInstruction[][] = [this.body];
  private readonly _scopes: Map<string, ValueId>[] = [new Map()];
  private readonly _loopIndices: ValueId[] = [];
  private _nextId = 1;

  constructor(
    private readonly _graph: WorkingGraph,
    private readonly _types: ReadonlyMap<NodeId, NodeTypes>,
    /**
     * Values read from a stage input instead of being computed: varyings in
     * the fragment stage.
     */
    private readonly _stageInputs: ReadonlyMap<string, string>
  ) {}

  emit(
    type: ShaderType,
    op: IrOp,
    args: readonly ValueId[] = [],
    node?: GraphNode
  ): ValueId {
    const id = this.newId();
    this.currentBody.push({
      id,
      type,
      op,
      args,
      ...(node?.label ? { name: node.label } : {}),
      ...(node ? { sourceNode: node.id } : {}),
    });
    return id;
  }

  newId(): ValueId {
    return this._nextId++;
  }

  /** The index of the loop being built, if any. */
  get loopIndex(): ValueId | undefined {
    return this._loopIndices[this._loopIndices.length - 1];
  }

  /** Starts the body of a loop with the given index. */
  beginLoop(index: ValueId): void {
    this._bodies.push([]);
    this._scopes.push(new Map());
    this._loopIndices.push(index);
  }

  /** Ends the body of the current loop and returns its instructions. */
  endLoop(): IrInstruction[] {
    this._scopes.pop();
    this._loopIndices.pop();
    return this._bodies.pop() as IrInstruction[];
  }

  define(ref: PortRef, value: ValueId): void {
    this.set(`${ref.node}:${ref.port}`, value);
  }

  private get currentBody(): IrInstruction[] {
    return this._bodies[this._bodies.length - 1];
  }

  private get(key: string): ValueId | undefined {
    for (let i = this._scopes.length - 1; i >= 0; i--) {
      const id = this._scopes[i].get(key);
      if (id !== undefined) {
        return id;
      }
    }
    return undefined;
  }

  private set(key: string, id: ValueId): void {
    this._scopes[this._scopes.length - 1].set(key, id);
  }

  /** The value of an output port in this stage. */
  value(ref: PortRef): { id: ValueId; type: ShaderType } {
    const key = `${ref.node}:${ref.port}`;
    const type = this._types.get(ref.node)?.outputs[ref.port] as ShaderType;
    let id = this.get(key);
    if (id === undefined) {
      const input = this._stageInputs.get(key);
      if (input === undefined) {
        throw new Error(
          `internal error: ${key} is not available in this stage`
        );
      }
      id = this.emit(type, { kind: 'load-input', input });
      this.set(key, id);
    }
    return { id, type };
  }

  /** The value of an input of a node, converted to the type of the port. */
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
        let id = this.get(key);
        if (id === undefined) {
          id = this.emit(
            type,
            { kind: 'swizzle', components: source.swizzle },
            [value.id]
          );
          this.set(key, id);
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

    /** Scalar splat, made explicit for the code generators. */
    if (value.type.kind === 'scalar' && expected.kind === 'vector') {
      return this.emit(expected, { kind: 'construct' }, [value.id]);
    }
    return value.id;
  }
}

// The outputs of 'light.current' used by the graph: elements of the light
// arrays of the frame block, at the index of the loop being built.
function translateCurrentLight(
  builder: StageBuilder,
  node: GraphNode,
  usedPorts: ReadonlySet<string>
): void {
  const index = builder.loopIndex;
  if (index === undefined) {
    throw new Error('internal error: light.current outside of a light loop');
  }
  for (const [port, { member, type }] of Object.entries(lightMembers)) {
    if (!usedPorts.has(port)) {
      continue;
    }
    const elements = lightArrayType(type);
    const array = builder.emit(elements, {
      kind: 'load-resource',
      binding: uniformBlockName('frame'),
      member,
    });
    let value = builder.emit(elements.element, { kind: 'index' }, [
      array,
      index,
    ]);
    if (type.kind === 'vector' && type.size < 4) {
      value = builder.emit(
        type,
        { kind: 'swizzle', components: 'xyzw'.slice(0, type.size) },
        [value]
      );
    }
    builder.define({ node: node.id, port }, value);
  }
}

function translateNode(
  builder: StageBuilder,
  resolved: ResolvedNode,
  types: NodeTypes,
  results: Record<string, ValueId>,
  usedPorts: ReadonlySet<string> = new Set()
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
      const resource = engineResources[params['value'] as string];
      if (resource) {
        output('value', types.outputs['value'], {
          kind: 'load-resource',
          binding: resource.name,
        });
        return;
      }
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
    case 'input.storage':
      output('value', types.outputs['value'], {
        kind: 'load-resource',
        binding: params['name'] as string,
      });
      return;
    case 'input.object':
      output(
        'value',
        types.outputs['value'],
        { kind: 'load-object', member: params['member'] as string },
        inputValues()
      );
      return;
    case 'input.builtin':
      output('value', types.outputs['value'], {
        kind: 'load-builtin',
        builtin: params['builtin'] as IrBuiltin,
      });
      return;
    case 'light.current':
      translateCurrentLight(builder, node, usedPorts);
      return;
    case 'output.vertex':
      results['clipPosition'] = inputValues()[0];
      return;
    case 'output.fragment':
      // color (absent in depth-only programs) and discard.
      for (const port of inputs) {
        const value = builder.input(node, port, types.inputs[port.name]);
        if (value !== undefined) {
          results[port.name] = value;
        }
      }
      return;
    case 'output.target':
      // An extra color target, by its name (checked distinct).
      results[params['name'] as string] = inputValues()[0];
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
    case 'texture-sample-level':
      output('result', type, { kind: 'sample-level' }, args);
      return;
    case 'texture-sample-compare':
      output('result', type, { kind: 'sample-compare' }, args);
      return;
    case 'index':
      output('result', type, { kind: 'index' }, args);
      return;
    case 'array-length':
      output('result', type, { kind: 'array-length' }, args);
      return;
    case 'less':
    case 'less-equal':
    case 'greater':
    case 'greater-equal':
    case 'equal':
    case 'not-equal':
      output(
        'result',
        type,
        { kind: 'compare', operator: comparisons[op] },
        args
      );
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

interface StageContext {
  readonly graph: WorkingGraph;
  readonly nodes: ReadonlyMap<NodeId, ResolvedNode>;
  readonly order: readonly NodeId[];
  readonly types: ReadonlyMap<NodeId, NodeTypes>;
  /** Nodes computed in the body of a light loop. */
  readonly loopBodies: ReadonlySet<NodeId>;
  /** Output ports of each node read by other nodes. */
  readonly usedPorts: ReadonlyMap<NodeId, ReadonlySet<string>>;
}

// The nodes depending on 'light.current' through a path that does not cross
// a 'light.sum': they are computed once per light, in the loop of the sum
// they feed.
export function lightLoopBodies(graph: WorkingGraph): Set<NodeId> {
  const dependent = new Set<NodeId>();
  const pending = [...graph.nodes.values()]
    .filter((node) => node.type === 'light.current')
    .map((node) => node.id);
  while (pending.length > 0) {
    const id = pending.pop() as NodeId;
    if (dependent.has(id)) {
      continue;
    }
    dependent.add(id);
    for (const edge of graph.edges) {
      if (
        edge.from.node === id &&
        graph.nodes.get(edge.to.node)?.type !== 'light.sum'
      ) {
        pending.push(edge.to.node);
      }
    }
  }
  return dependent;
}

function translate(
  context: StageContext,
  builder: StageBuilder,
  id: NodeId,
  results: Record<string, ValueId>
): void {
  const resolved = context.nodes.get(id) as ResolvedNode;
  if (resolved.node.type === 'light.sum') {
    translateLightSum(context, builder, resolved);
    return;
  }
  translateNode(
    builder,
    resolved,
    context.types.get(id) as NodeTypes,
    results,
    context.usedPorts.get(id)
  );
}

// A loop over the lights of the frame, summing the value computed by the
// light-dependent nodes the input depends on. The other nodes it depends on
// are computed before the loop.
function translateLightSum(
  context: StageContext,
  builder: StageBuilder,
  { node, inputs }: ResolvedNode
): void {
  const types = context.types.get(node.id) as NodeTypes;
  const body = new Set<NodeId>();
  const pending = context.graph.incoming(node.id).map((edge) => edge.from.node);
  while (pending.length > 0) {
    const id = pending.pop() as NodeId;
    if (body.has(id) || !context.loopBodies.has(id)) {
      continue;
    }
    body.add(id);
    pending.push(...context.graph.incoming(id).map((edge) => edge.from.node));
  }

  const count = builder.emit(BuiltinTypes.u32, {
    kind: 'load-resource',
    binding: uniformBlockName('frame'),
    member: 'lightCount',
  });
  const index = builder.newId();
  builder.beginLoop(index);
  for (const id of context.order) {
    if (body.has(id)) {
      translate(context, builder, id, {});
    }
  }
  const result = builder.input(
    node,
    inputs[0],
    types.inputs['value']
  ) as ValueId;
  const instructions = builder.endLoop();
  builder.define(
    { node: node.id, port: 'result' },
    builder.emit(
      types.outputs['result'],
      { kind: 'loop-sum', index, body: instructions, result },
      [count],
      node
    )
  );
}

function translateStage(
  context: StageContext,
  builder: StageBuilder,
  stageNodes: ReadonlySet<NodeId>,
  results: Record<string, ValueId>
): void {
  for (const id of context.order) {
    // Loop bodies are translated with their light.sum.
    if (stageNodes.has(id) && !context.loopBodies.has(id)) {
      translate(context, builder, id, results);
    }
  }
}

// A compute graph: a single stage, without inputs nor varyings; its
// write.storage nodes become the writes of the stage, in graph order.
export function generateComputeIr({
  graph,
  nodes,
  order,
  types,
}: {
  graph: WorkingGraph;
  nodes: ReadonlyMap<NodeId, ResolvedNode>;
  order: readonly NodeId[];
  types: ReadonlyMap<NodeId, NodeTypes>;
}): ShaderModuleIR {
  const usedPorts = new Map<NodeId, Set<string>>();
  for (const edge of graph.edges) {
    let ports = usedPorts.get(edge.from.node);
    if (!ports) {
      ports = new Set();
      usedPorts.set(edge.from.node, ports);
    }
    ports.add(edge.from.port);
  }
  const context: StageContext = {
    graph,
    nodes,
    order,
    types,
    loopBodies: new Set(),
    usedPorts,
  };
  const builder = new StageBuilder(graph, types, new Map());
  const writes: IrWrite[] = [];
  let workgroupSize: [number, number, number] = [64, 1, 1];

  for (const id of order) {
    const resolved = nodes.get(id) as ResolvedNode;
    const { node, inputs, params } = resolved;
    if (node.type === 'output.compute') {
      workgroupSize = params['workgroupSize'] as [number, number, number];
      continue;
    }
    if (node.type !== 'write.storage') {
      translate(context, builder, id, {});
      continue;
    }
    const portTypes = types.get(id) as NodeTypes;
    const value = (name: string) =>
      builder.input(
        node,
        inputs.find((port) => port.name === name) as PortSchema,
        portTypes.inputs[name]
      );
    const array = graph.inputSource(node, 'array');
    const storage =
      array && 'ref' in array ? graph.nodes.get(array.ref.node) : undefined;
    const condition = value('when');
    writes.push({
      resource: storage?.params['name'] as string,
      index: value('index') as ValueId,
      value: value('value') as ValueId,
      ...(condition === undefined ? {} : { condition }),
    });
  }

  return {
    name: graph.name,
    entryPoints: [
      {
        stage: 'compute',
        inputs: [],
        outputs: [],
        body: builder.body,
        results: {},
        workgroupSize,
        writes,
      },
    ],
  };
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
  const usedPorts = new Map<NodeId, Set<string>>();
  for (const edge of graph.edges) {
    let ports = usedPorts.get(edge.from.node);
    if (!ports) {
      ports = new Set();
      usedPorts.set(edge.from.node, ports);
    }
    ports.add(edge.from.port);
  }
  const context: StageContext = {
    graph,
    nodes,
    order,
    types,
    loopBodies: lightLoopBodies(graph),
    usedPorts,
  };

  // Vertex stage: attributes are its inputs.
  const attributeInputs = new Map(
    plan.attributes.map((attribute) => [
      `${attribute.node}:value`,
      attribute.name,
    ])
  );
  const vertex = new StageBuilder(graph, types, attributeInputs);
  const vertexResults: Record<string, ValueId> = {};
  translateStage(context, vertex, plan.vertex, vertexResults);
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
  translateStage(context, fragment, plan.fragment, fragmentResults);

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
      outputs: fragmentOutputs(graph, types, fragmentResults),
      body: fragment.body,
      results: fragmentResults,
    },
  ];

  return { name: graph.name, entryPoints };
}

// The color targets of the fragment stage, by location: the color of
// output.fragment, then those of the output.target nodes.
function fragmentOutputs(
  graph: WorkingGraph,
  types: ReadonlyMap<NodeId, NodeTypes>,
  results: Readonly<Record<string, ValueId>>
): IrStageVariable[] {
  const outputs: IrStageVariable[] =
    results['color'] !== undefined
      ? [{ name: 'color', type: BuiltinTypes.vec4f, location: 0 }]
      : [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'output.target') {
      outputs.push({
        name: node.params['name'] as string,
        type: types.get(node.id)?.inputs['value'] as ShaderType,
        location: node.params['location'] as number,
      });
    }
  }
  return outputs.sort((a, b) => (a.location ?? 0) - (b.location ?? 0));
}
