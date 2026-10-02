import { ConstantValue } from '../types/ConstantValue';
import {
  ShaderType,
  TextureDimension,
  TextureSampleType,
} from '../types/ShaderType';
import { createStandardRegistry, ShadingModel } from '../std';
import { Diagnostic, GraphError } from './Diagnostic';
import { resolveNodeTypes } from './inference';
import {
  GraphEdge,
  GraphNode,
  GraphParameterDeclaration,
  MaterialGraphData,
  MaterialGraphFormat,
  MaterialGraphVersion,
  NodeId,
  StaticValue,
} from './MaterialGraphData';
import type { NodeDefinition, StaticParams } from './NodeDefinition';
import { NodeRegistry } from './NodeRegistry';
import { composeSwizzles, swizzleType } from './swizzle';
import { resolveGraphNode, validateGraph } from './validateGraph';

// A typed reference to an output port, possibly swizzled.
export class PortHandle {
  constructor(
    readonly node: NodeId,
    readonly port: string,
    // Type of the value, after the swizzle.
    readonly type: ShaderType,
    readonly swizzleMask?: string
  ) {}

  swizzle(mask: string): PortHandle {
    const type = swizzleType(this.type, mask);
    if (typeof type === 'string') {
      throw new GraphError([
        { severity: 'error', node: this.node, port: this.port, message: type },
      ]);
    }
    const combined = this.swizzleMask
      ? (composeSwizzles(this.swizzleMask, mask) as string)
      : mask;
    return new PortHandle(this.node, this.port, type, combined);
  }
}

export type NodeInputs = Readonly<Record<string, PortHandle | ConstantValue>>;

export interface NodeOptions {
  readonly params?: StaticParams;
  readonly inputs?: NodeInputs;
  readonly label?: string;
}

// The surface ports, plus the shading model. The index signature has to
// accept the shading model string too.
export type SurfaceInputs = {
  readonly shadingModel?: ShadingModel;
  readonly [port: string]:
    | PortHandle
    | ConstantValue
    | ShadingModel
    | undefined;
};

type Slot = 'frame' | 'material' | 'object' | (string & {});

// Builds a MaterialGraphData step by step. Types are checked as soon as a node
// is added, so errors point at the faulty call.
export class GraphBuilder {
  readonly name: string;
  readonly registry: NodeRegistry;

  private readonly _nodes: GraphNode[] = [];
  private readonly _edges: GraphEdge[] = [];
  private readonly _parameters: GraphParameterDeclaration[] = [];
  private _nextId = 1;
  private readonly _outputTypes: string[] = [];

  constructor(name: string, registry: NodeRegistry = createStandardRegistry()) {
    this.name = name;
    this.registry = registry;
  }

  // Adds a node and returns its outputs, by port name.
  node(
    definition: NodeDefinition | string,
    { params = {}, inputs = {}, label }: NodeOptions = {}
  ): Readonly<Record<string, PortHandle>> {
    const resolvedDefinition = this.resolveDefinition(definition);
    const id = `n${this._nextId++}`;

    const defaults: Record<string, ConstantValue> = {};
    const edges: GraphEdge[] = [];
    const connected: Record<string, ShaderType> = {};
    for (const [port, value] of Object.entries(inputs)) {
      if (value instanceof PortHandle) {
        edges.push({
          from: { node: value.node, port: value.port },
          to: { node: id, port },
          ...(value.swizzleMask ? { swizzle: value.swizzleMask } : {}),
        });
        connected[port] = value.type;
      } else {
        defaults[port] = value;
      }
    }

    const node: GraphNode = {
      id,
      type: resolvedDefinition.id,
      params,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      ...(label ? { label } : {}),
    };

    const diagnostics: Diagnostic[] = [];
    const resolved = resolveGraphNode(node, this.registry, diagnostics);
    if (!resolved) {
      throw new GraphError(diagnostics);
    }

    for (const port of Object.keys(inputs)) {
      if (!resolved.inputs.some((input) => input.name === port)) {
        diagnostics.push({
          severity: 'error',
          node: id,
          port,
          message: `${resolvedDefinition.id} has no input "${port}"`,
        });
      }
    }

    const resolution = resolveNodeTypes({
      inputs: resolved.inputs,
      outputs: resolved.outputs,
      connected,
      defaults,
    });
    for (const error of resolution.errors) {
      diagnostics.push({
        severity: 'error',
        node: id,
        port: error.port,
        message: `${resolvedDefinition.id}: ${error.message}`,
      });
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new GraphError(diagnostics);
    }

    if (resolvedDefinition.category === 'output') {
      // Allowed: one output.surface, or output.vertex and output.fragment.
      const outputs = [...this._outputTypes, resolvedDefinition.id].sort();
      const allowed =
        outputs.length === 1 ||
        (outputs[0] === 'output.fragment' && outputs[1] === 'output.vertex');
      if (!allowed) {
        throw new GraphError([
          {
            severity: 'error',
            node: id,
            message: 'the graph already has an output node',
          },
        ]);
      }
      this._outputTypes.push(resolvedDefinition.id);
    }

    this._nodes.push(node);
    this._edges.push(...edges);

    const outputs: Record<string, PortHandle> = {};
    for (const [port, type] of Object.entries(resolution.types.outputs)) {
      outputs[port] = new PortHandle(id, port, type);
    }
    return outputs;
  }

  // Adds a function node with a single output and returns that output.
  call(
    definition: NodeDefinition | string,
    inputs: NodeInputs = {},
    options: Omit<NodeOptions, 'inputs'> = {}
  ): PortHandle {
    const outputs = Object.values(
      this.node(definition, { ...options, inputs })
    );
    if (outputs.length !== 1) {
      throw new Error(
        `call() needs a node with exactly one output, use node() instead`
      );
    }
    return outputs[0];
  }

  attribute(semantic: string, type: ShaderType, label?: string): PortHandle {
    return this.call(
      'input.attribute',
      {},
      { params: { semantic, type }, label }
    );
  }

  uniform(
    name: string,
    type: ShaderType,
    options: { slot?: Slot; default?: ConstantValue } = {}
  ): PortHandle {
    return this.call(
      'input.uniform',
      {},
      { params: withDefined({ name, type, ...options }), label: name }
    );
  }

  storage(
    name: string,
    type: ShaderType,
    options: { slot?: Slot; access?: 'read' | 'read-write' } = {}
  ): PortHandle {
    return this.call(
      'input.storage',
      {},
      { params: withDefined({ name, type, ...options }), label: name }
    );
  }

  texture(
    name: string,
    options: {
      dimension?: TextureDimension;
      sampleType?: TextureSampleType;
      slot?: Slot;
    } = {}
  ): PortHandle {
    return this.call(
      'input.texture',
      {},
      { params: withDefined({ name, ...options }), label: name }
    );
  }

  sampler(
    name: string,
    options: { comparison?: boolean; slot?: Slot } = {}
  ): PortHandle {
    return this.call(
      'input.sampler',
      {},
      { params: withDefined({ name, ...options }), label: name }
    );
  }

  builtin(
    builtin: 'vertex-index' | 'instance-index' | 'frag-coord' | 'front-facing'
  ): PortHandle {
    return this.call('input.builtin', {}, { params: { builtin } });
  }

  engine(
    value:
      | 'camera.view'
      | 'camera.projection'
      | 'camera.viewProjection'
      | 'camera.position'
      | 'object.world'
      | 'object.normalMatrix'
      | 'time'
  ): PortHandle {
    return this.call('input.engine', {}, { params: { value } });
  }

  constant(type: ShaderType, value: ConstantValue, label?: string): PortHandle {
    return this.call('const.value', {}, { params: { type, value }, label });
  }

  surface(inputs: SurfaceInputs = {}): void {
    const { shadingModel = 'unlit', ...ports } = inputs;
    this.node('output.surface', {
      params: { shadingModel },
      inputs: ports as NodeInputs,
    });
  }

  // Declares a static parameter (a "feature") of the graph.
  parameter(
    name: string,
    defaultValue: StaticValue,
    description?: string
  ): this {
    if (this._parameters.some((parameter) => parameter.name === name)) {
      throw new Error(`Parameter "${name}" is already declared`);
    }
    this._parameters.push(
      description === undefined
        ? { name, default: defaultValue }
        : { name, default: defaultValue, description }
    );
    return this;
  }

  // Validates the whole graph and returns it. Throws a GraphError when the
  // graph has errors; warnings are accepted.
  build(): MaterialGraphData {
    const graph: MaterialGraphData = {
      format: MaterialGraphFormat,
      version: MaterialGraphVersion,
      name: this.name,
      nodes: [...this._nodes],
      edges: [...this._edges],
      ...(this._parameters.length > 0
        ? { parameters: [...this._parameters] }
        : {}),
    };

    const validation = validateGraph(graph, this.registry);
    if (!validation.valid) {
      throw new GraphError(validation.diagnostics);
    }
    return graph;
  }

  private resolveDefinition(
    definition: NodeDefinition | string
  ): NodeDefinition {
    if (typeof definition === 'string') {
      return this.registry.require(definition);
    }
    const registered = this.registry.get(definition.id);
    if (!registered) {
      // Custom node types are registered on first use.
      this.registry.register(definition);
      return definition;
    }
    if (registered !== definition) {
      throw new Error(
        `Another node type is already registered with the id "${definition.id}"`
      );
    }
    return definition;
  }
}

// Drops the undefined options, so that the declared parameter defaults apply.
function withDefined(
  params: Record<string, StaticValue | undefined>
): StaticParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined)
  ) as StaticParams;
}
