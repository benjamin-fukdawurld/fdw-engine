import { ConstantValue } from '../types/ConstantValue';
import {
  ShaderType,
  TextureDimension,
  TextureSampleType,
} from '../types/ShaderType';
import {
  createStandardRegistry,
  ShadingModel,
  standardNodeDefinitions,
} from '../std';
import { Diagnostic, GraphError } from './Diagnostic';
import { resolveNodeTypes } from './inference';
import {
  GraphEdge,
  GraphNode,
  GraphParameterDeclaration,
  GraphFunctionData,
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
import { isGraphFunction } from './functions';

/**
 * A typed reference to an output port of a node, possibly swizzled.
 *
 * Port handles are returned by the {@link GraphBuilder} methods and passed as
 * inputs of other nodes.
 *
 * @group Building graphs
 */
export class PortHandle {
  constructor(
    /** Id of the node. */
    readonly node: NodeId,
    /** Name of the output port. */
    readonly port: string,
    /** Type of the value, after the swizzle. */
    readonly type: ShaderType,
    /** Components selected from the port value ('xyz', 'a'…), if any. */
    readonly swizzleMask?: string
  ) {}

  /**
   * Selects components of a vector value. Swizzles compose:
   * `color.swizzle('xyz').swizzle('zx')` reads `color.zx`.
   *
   * @param mask - Components to select, from `xyzw` or `rgba` (not mixed).
   * @throws {@link GraphError} when the value is not a vector or a component is
   * out of range.
   *
   * @example
   * ```ts
   * g.surface({ baseColor: texel.swizzle('rgb'), alpha: texel.swizzle('a') });
   * ```
   */
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

/**
 * Values of the inputs of a node, by port name: a port of another node, or a
 * literal.
 *
 * @group Building graphs
 */
export type NodeInputs = Readonly<Record<string, PortHandle | ConstantValue>>;

/**
 * Options of {@link GraphBuilder.node}.
 *
 * @group Building graphs
 */
export interface NodeOptions {
  /** Compile-time parameters of the node, as declared by its definition. */
  readonly params?: StaticParams;
  /** Values of the inputs. */
  readonly inputs?: NodeInputs;
  /** Name of the node, used to name the variables of the generated code. */
  readonly label?: string;
}

/**
 * Inputs of {@link GraphBuilder.surface}: the surface ports of the shading
 * model (`baseColor`, `alpha`, `normal`, `shininess`…), plus the shading model
 * itself.
 *
 * @group Building graphs
 */
export type SurfaceInputs = {
  /** Shading model of the surface. Defaults to `'unlit'`. */
  readonly shadingModel?: ShadingModel;
  // The inputs of the shading model; shadingModel is the only string.
  readonly [port: string]: PortHandle | ConstantValue | string | undefined;
};

/**
 * A binding slot: groups the resources by update frequency. `'material'` is
 * the default for material resources; `'frame'` and `'object'` are reserved
 * for engine values; custom slots get their own bind group.
 *
 * @group Building graphs
 */
export type BindingSlot = 'frame' | 'material' | 'object' | (string & {});

/**
 * Builds a {@link MaterialGraphData} step by step.
 *
 * Types are checked as soon as a node is added, so errors point at the faulty
 * call. Call {@link GraphBuilder.build} at the end to validate the whole graph.
 *
 * @example
 * ```ts
 * import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
 *
 * const g = new GraphBuilder('textured');
 * const texel = g.call(std.textureSample, {
 *   texture: g.texture('diffuseMap'),
 *   sampler: g.sampler('diffuseSampler'),
 *   uv: g.attribute('uv', BuiltinTypes.vec2f),
 * });
 * const tint = g.uniform('tint', BuiltinTypes.vec4f, { default: [1, 1, 1, 1] });
 * const color = g.call(std.mul, { a: texel, b: tint });
 * g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
 *
 * const graph = g.build();
 * ```
 *
 * @group Building graphs
 */
export class GraphBuilder {
  /** Name of the graph, used in diagnostics and in the generated code. */
  readonly name: string;
  /**
   * Node types available to the graph. Custom node types passed to
   * {@link GraphBuilder.node} are registered on first use.
   */
  readonly registry: NodeRegistry;

  private readonly _nodes: GraphNode[] = [];
  private readonly _edges: GraphEdge[] = [];
  private readonly _parameters: GraphParameterDeclaration[] = [];
  private _nextId = 1;
  private readonly _outputTypes: string[] = [];

  /**
   * @param name - Name of the graph.
   * @param registry - Node types available to the graph. Defaults to the
   * standard library ({@link createStandardRegistry}).
   */
  constructor(name: string, registry: NodeRegistry = createStandardRegistry()) {
    this.name = name;
    this.registry = registry;
  }

  /**
   * Adds a node and returns its outputs, by port name.
   *
   * Use it for nodes with several outputs or none; {@link GraphBuilder.call} is
   * shorter for the others.
   *
   * @param definition - The node type, or its id.
   * @throws {@link GraphError} on unknown types, invalid parameters, unknown
   * inputs or type errors.
   *
   * @example
   * ```ts
   * g.node('output.vertex', { inputs: { clipPosition } });
   * ```
   */
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

    const computeOutputs = ['output.compute', 'write.storage'];
    if (computeOutputs.includes(resolvedDefinition.id)) {
      // Several writes are allowed: the whole graph is checked on build.
      this._outputTypes.push(resolvedDefinition.id);
    } else if (resolvedDefinition.id === 'function.output') {
      if (this._outputTypes.some((type) => type !== 'function.output')) {
        throw new GraphError([
          {
            severity: 'error',
            node: id,
            message: 'a function graph cannot have stage outputs',
          },
        ]);
      }
      this._outputTypes.push(resolvedDefinition.id);
    } else if (
      resolvedDefinition.id === 'output.target' ||
      resolvedDefinition.id === 'output.value'
    ) {
      // Several are allowed: the whole graph is checked on build.
      this._outputTypes.push(resolvedDefinition.id);
    } else if (resolvedDefinition.category === 'output') {
      // Allowed: one output.surface, or output.vertex and output.fragment.
      const outputs = [
        ...this._outputTypes.filter(
          (type) => type !== 'output.target' && type !== 'output.value'
        ),
        resolvedDefinition.id,
      ].sort();
      if (this._outputTypes.includes('function.output')) {
        throw new GraphError([
          {
            severity: 'error',
            node: id,
            message: 'a function graph cannot have stage outputs',
          },
        ]);
      }
      const allowed =
        !this._outputTypes.some((type) => computeOutputs.includes(type)) &&
        (outputs.length === 1 ||
          (outputs[0] === 'output.fragment' && outputs[1] === 'output.vertex'));
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

  /**
   * Adds a node with a single output and returns that output.
   *
   * Literals can be given directly as inputs: a number is splatted to a vector
   * when needed.
   *
   * @example
   * ```ts
   * const doubled = g.call(std.mul, { a: normal, b: 2 });
   * const facing = g.call(std.saturate, {
   *   x: g.call(std.dot, { a: normal, b: [0, 1, 0] }),
   * });
   * ```
   */
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

  /**
   * Reads a vertex attribute of the mesh.
   *
   * @param semantic - Semantic of the attribute: `'position'`, `'normal'`,
   * `'uv'`, `'color'`, `'tangent'`… or a custom one.
   * @param type - Type read by the shader.
   */
  attribute(semantic: string, type: ShaderType, label?: string): PortHandle {
    return this.call(
      'input.attribute',
      {},
      { params: { semantic, type }, label }
    );
  }

  /**
   * Reads a uniform value of the material. Its value is set on the material at
   * runtime, without recompiling the shader.
   *
   * @param name - Name of the uniform, used to set its value.
   * @param options.slot - Binding slot, `'material'` by default.
   * @param options.default - Initial value on new materials.
   */
  uniform(
    name: string,
    type: ShaderType,
    options: { slot?: BindingSlot; default?: ConstantValue } = {}
  ): PortHandle {
    return this.call(
      'input.uniform',
      {},
      { params: withDefined({ name, type, ...options }), label: name }
    );
  }

  /**
   * Reads a storage buffer: a runtime-sized array (`arrayType(element)`) of
   * scalars, vectors or matrices, read with `std.index` and
   * `std.arrayLength`. Read-only for now.
   */
  storage(
    name: string,
    type: ShaderType,
    options: { slot?: BindingSlot; access?: 'read' | 'read-write' } = {}
  ): PortHandle {
    return this.call(
      'input.storage',
      {},
      { params: withDefined({ name, type, ...options }), label: name }
    );
  }

  /**
   * Reads a texture of the material, to sample with `std.textureSample`.
   *
   * @param options.dimension - `'2d'` by default.
   * @param options.sampleType - `'float'` by default.
   */
  texture(
    name: string,
    options: {
      dimension?: TextureDimension;
      sampleType?: TextureSampleType;
      slot?: BindingSlot;
    } = {}
  ): PortHandle {
    return this.call(
      'input.texture',
      {},
      { params: withDefined({ name, ...options }), label: name }
    );
  }

  /** Reads a sampler of the material, to sample textures with. */
  sampler(
    name: string,
    options: { comparison?: boolean; slot?: BindingSlot } = {}
  ): PortHandle {
    return this.call(
      'input.sampler',
      {},
      { params: withDefined({ name, ...options }), label: name }
    );
  }

  /**
   * Reads a value provided by the GPU: vertex and instance index (vertex
   * stage), fragment coordinate and facing (fragment stage).
   */
  builtin(
    builtin:
      | 'vertex-index'
      | 'instance-index'
      | 'object-index'
      | 'frag-coord'
      | 'front-facing'
      // Graphs ending with output.fullscreen.
      | 'screen-uv'
      // Compute graphs.
      | 'global-invocation-id'
      | 'local-invocation-id'
      | 'workgroup-id'
      | 'num-workgroups'
  ): PortHandle {
    return this.call('input.builtin', {}, { params: { builtin } });
  }

  /**
   * Reads a value provided by the engine: camera, object transform, time,
   * the identifier of the object (`object.id`, a u32, 0 for none). These
   * values live in the fixed `frame` and `object` slots, shared by
   * every material. The lights are read with `light.current` and summed with
   * `light.sum` (see `stdLights`).
   */
  engine(
    value:
      | 'camera.view'
      | 'camera.projection'
      | 'camera.viewProjection'
      | 'camera.position'
      | 'object.world'
      | 'object.normalMatrix'
      | 'object.id'
      | 'time'
      | 'exposure'
      | 'shadowMap'
      | 'shadowSampler'
  ): PortHandle {
    return this.call('input.engine', {}, { params: { value } });
  }

  /**
   * An input of a function graph: a port of the function node.
   *
   * @param options.default - Value used when the call leaves the input
   * unconnected; without it, the input must be connected.
   * @see {@link defineFunction}
   */
  functionInput(
    name: string,
    type: ShaderType,
    options: { default?: ConstantValue; label?: string } = {}
  ): PortHandle {
    return this.call(
      'function.input',
      {},
      {
        params: withDefined({ name, type, default: options.default }),
        ...(options.label ? { label: options.label } : {}),
      }
    );
  }

  /**
   * An output of a function graph: a port of the function node, of the type
   * of the value.
   *
   * @see {@link defineFunction}
   */
  functionOutput(name: string, value: PortHandle | ConstantValue): void {
    this.node('function.output', { params: { name }, inputs: { value } });
  }

  /**
   * A constant value. It is part of the generated code: changing it recompiles
   * the shader. Use {@link GraphBuilder.uniform} for values that change.
   */
  constant(type: ShaderType, value: ConstantValue, label?: string): PortHandle {
    return this.call('const.value', {}, { params: { type, value }, label });
  }

  /**
   * Ends the graph with the surface of the material. The compiler adds the
   * standard vertex stage and the lighting of the shading model.
   *
   * @example
   * ```ts
   * g.surface({ shadingModel: 'phong', baseColor: color, shininess: 32 });
   * ```
   */
  surface(inputs: SurfaceInputs = {}): void {
    const { shadingModel = 'unlit', ...ports } = inputs as SurfaceInputs & {
      shadingModel?: ShadingModel;
    };
    this.node('output.surface', {
      params: { shadingModel },
      inputs: ports as NodeInputs,
    });
  }

  /**
   * Ends a full screen pass (a post-processing effect): the color of each
   * pixel, usually computed from `builtin('screen-uv')` and textures.
   */
  fullscreen({ color }: { color: PortHandle | ConstantValue }): void {
    this.node('output.fullscreen', { inputs: { color } });
  }

  /**
   * Writes a value to an extra color target of the pass (multiple render
   * targets), besides the color of the fragment or of the full screen pass
   * (location 0). With output.vertex and output.fragment, or
   * output.fullscreen.
   *
   * @example
   * ```ts
   * g.fullscreen({ color });
   * g.target('normal', normal, 1);
   * ```
   */
  target(
    name: string,
    value: PortHandle | ConstantValue,
    location: number
  ): void {
    this.node('output.target', {
      params: { name, location },
      inputs: { value },
    });
  }

  /**
   * A value of the material for a scene output declared `'material'` (see
   * the outputs of `Renderer.addScenePasses`): written to the target of
   * that name by the passes that have it, ignored by the others. Its type
   * matches the format of the target (`vec2f` for `rg16float`, `u32` for
   * `r32uint`). With {@link GraphBuilder.surface}.
   *
   * @example
   * ```ts
   * g.surface({ baseColor });
   * g.output('velocity', velocity);
   * ```
   */
  output(name: string, value: PortHandle | ConstantValue): void {
    this.node('output.value', { params: { name }, inputs: { value } });
  }

  /**
   * Ends a compute graph: what it computes is written by its
   * {@link GraphBuilder.write} calls.
   *
   * @param options.workgroupSize - Threads of a workgroup, in x, y and z
   * (64 × 1 × 1 by default).
   */
  compute(
    options: { workgroupSize?: readonly [number, number, number] } = {}
  ): void {
    this.node('output.compute', {
      params: withDefined({ workgroupSize: options.workgroupSize }),
    });
  }

  /**
   * In a compute graph: array[index] = value, when `when` is true. The array
   * is a storage buffer declared with read-write access.
   */
  write(
    array: PortHandle,
    {
      index,
      value,
      when,
    }: {
      index: PortHandle | number;
      value: PortHandle | ConstantValue;
      when?: PortHandle;
    }
  ): void {
    this.node('write.storage', {
      inputs: { array, index, value, ...(when ? { when } : {}) },
    });
  }

  /**
   * Declares a static parameter (a "feature") of the graph, read by the
   * macros. Materials can override its value.
   *
   * @example
   * ```ts
   * g.parameter('useTexture', false, 'Samples the diffuse map');
   * ```
   */
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

  /**
   * Validates the whole graph and returns it.
   *
   * @throws {@link GraphError} when the graph has errors; warnings are
   * accepted.
   */
  build(): MaterialGraphData {
    // The function graphs called by the graph are embedded: the graph then
    // compiles without registering them.
    // The standard ones are known by every registry.
    const standard = new Set(standardNodeDefinitions());
    const types = new Set(this._nodes.map((node) => node.type));
    // The shading model of the surface is a node type too.
    for (const node of this._nodes) {
      if (node.type === 'output.surface') {
        types.add(`lighting.${node.params['shadingModel'] ?? 'unlit'}`);
      }
    }
    const functions: GraphFunctionData[] = [];
    for (const type of types) {
      const definition = this.registry.get(type);
      if (isGraphFunction(definition) && !standard.has(definition)) {
        functions.push({
          id: definition.id,
          ...(definition.description
            ? { description: definition.description }
            : {}),
          graph: definition.implementation.graph,
        });
      }
    }
    const graph: MaterialGraphData = {
      format: MaterialGraphFormat,
      version: MaterialGraphVersion,
      name: this.name,
      nodes: [...this._nodes],
      edges: [...this._edges],
      ...(this._parameters.length > 0
        ? { parameters: [...this._parameters] }
        : {}),
      ...(functions.length > 0 ? { functions } : {}),
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
