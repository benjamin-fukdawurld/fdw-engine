import type { ConstantValue } from '../types/ConstantValue';
import type { NodeRegistry } from './NodeRegistry';
import type { PortType } from '../types/PortType';
import type { ShaderType } from '../types/ShaderType';
import type {
  GraphNode,
  MaterialGraphData,
  StaticValue,
  ValueSource,
} from './MaterialGraphData';

/**
 * Categories of node types.
 *
 * @group Node definitions
 */
export const NodeCategoryNames = [
  'input',
  'constant',
  'function',
  'macro',
  'output',
] as const;
/**
 * The category of a node type:
 * - `input`: reads a value (attribute, uniform, texture, engine value…);
 * - `constant`: a constant value;
 * - `function`: computes values from its inputs;
 * - `macro`: replaced by other nodes at compile time;
 * - `output`: ends the graph.
 *
 * @group Node definitions
 */
export type NodeCategory = (typeof NodeCategoryNames)[number];

/**
 * A shader stage.
 *
 * @group Node definitions
 */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/**
 * An input or output port of a node type.
 *
 * @group Node definitions
 */
export interface PortSchema {
  readonly name: string;
  readonly type: PortType;
  /** Value used when the input is not connected. */
  readonly default?: ConstantValue;
  /** An optional input can stay unconnected without a default value. */
  readonly optional?: boolean;
}

/**
 * The kind of value of a compile-time parameter.
 *
 * @group Node definitions
 */
export type ParamKind = 'string' | 'number' | 'boolean' | 'type' | 'constant';

/**
 * A compile-time parameter of a node type.
 *
 * @group Node definitions
 */
export interface ParamSchema {
  readonly kind: ParamKind;
  /** Allowed values, for string parameters. */
  readonly values?: readonly string[];
  readonly default?: StaticValue;
  readonly required?: boolean;
}

/**
 * Compile-time parameters of a node, by name.
 *
 * @group Node definitions
 */
export type StaticParams = Readonly<Record<string, StaticValue>>;

/**
 * What the ports of a node can depend on, besides its parameters: the
 * registry the graph is resolved with (the ports of `output.surface` are
 * those of its shading model).
 *
 * @group Node definitions
 */
export interface PortContext {
  readonly registry?: NodeRegistry;
}

/**
 * A node type: its category, parameters and ports.
 *
 * @example A custom function node
 * ```ts
 * const scale: FunctionDefinition = {
 *   id: 'my.scale',
 *   category: 'function',
 *   implementation: { kind: 'intrinsic', op: 'mul' },
 *   inputs: () => [
 *     { name: 'value', type: BuiltinTypes.f32 },
 *     { name: 'factor', type: BuiltinTypes.f32, default: 0.5 },
 *   ],
 *   outputs: () => [{ name: 'result', type: BuiltinTypes.f32 }],
 * };
 * g.call(scale, { value: x });
 * ```
 *
 * @group Node definitions
 */
export interface NodeDefinition {
  /** 'std.mul', 'input.uniform'… */
  readonly id: string;
  /** Category of the node type. */
  readonly category: NodeCategory;
  /** Description, for documentation and editors. */
  readonly description?: string;
  /** Compile-time parameters. */
  readonly params?: Readonly<Record<string, ParamSchema>>;
  /**
   * Ports can depend on the parameters: the output of 'input.uniform' has the
   * type given by its 'type' parameter.
   */
  inputs(params: StaticParams, context?: PortContext): readonly PortSchema[];
  /** Output ports, given the parameters. */
  outputs(params: StaticParams, context?: PortContext): readonly PortSchema[];
  /** Restricts the node to a stage (derivatives, implicit-LOD sampling…). */
  stage?(params: StaticParams): ShaderStage | undefined;
}

/**
 * Operations every code generator knows how to translate.
 *
 * @group Node definitions
 */
export type IntrinsicOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'min'
  | 'max'
  | 'abs'
  | 'floor'
  | 'fract'
  | 'sqrt'
  | 'sin'
  | 'cos'
  | 'pow'
  | 'dot'
  | 'cross'
  | 'length'
  | 'normalize'
  | 'reflect'
  | 'mix'
  | 'clamp'
  | 'smoothstep'
  | 'saturate'
  | 'step'
  // Screen space derivatives, in the fragment stage only.
  | 'dpdx'
  | 'dpdy'
  | 'fwidth'
  // Returns its input unchanged: used to force a computation per fragment.
  | 'identity'
  | 'select'
  | 'construct'
  | 'convert'
  | 'texture-sample'
  // Sampling at an explicit level of detail.
  | 'texture-sample-level'
  // Depth comparison with a depth texture (shadow maps).
  | 'texture-sample-compare'
  // A texel read by its coordinates, without sampler nor filtering.
  | 'texture-load'
  // Component-wise comparisons, giving booleans.
  | 'less'
  | 'less-equal'
  | 'greater'
  | 'greater-equal'
  | 'equal'
  | 'not-equal'
  // Sums its input over the lights of the frame (light.sum).
  | 'light-sum'
  // array[index], and the number of elements of a runtime-sized array.
  | 'index'
  | 'array-length';

/**
 * Code provided per shading language. Breaks portability: compilation fails
 * for a backend whose language has no implementation.
 *
 * @group Node definitions
 */
export type NativeShaderLanguage =
  | 'wgsl'
  | 'glsl-es-300'
  | 'glsl-450'
  | 'msl'
  | 'hlsl';

/**
 * How a function node is implemented: an intrinsic operation, a subgraph or
 * native code. Only intrinsics are supported by the compiler for now.
 *
 * @group Node definitions
 */
export type FunctionImplementation =
  /** An IR operation that every code generator knows how to translate. */
  | { readonly kind: 'intrinsic'; readonly op: IntrinsicOp }
  /** Defined by a subgraph, emitted as a function of the target language. */
  | { readonly kind: 'graph'; readonly graph: MaterialGraphData }
  | {
      readonly kind: 'native';
      readonly sources: Readonly<Partial<Record<NativeShaderLanguage, string>>>;
    };

/**
 * A node type computing values from its inputs.
 *
 * @group Node definitions
 */
export interface FunctionDefinition extends NodeDefinition {
  readonly category: 'function';
  /** How the function is implemented. */
  readonly implementation: FunctionImplementation;
}

/**
 * What a macro can do while it is expanded.
 *
 * @group Node definitions
 */
export interface MacroContext {
  /** The macro node being expanded. */
  readonly node: GraphNode;
  /** Its resolved compile-time parameters. */
  readonly params: StaticParams;
  /**
   * The value feeding an input: its edge, the node default or the port
   * default; undefined for an unconnected optional input.
   */
  input(port: string): ValueSource | undefined;
  /** Concrete type of an input or output port of the macro node. */
  typeOf(port: string): ShaderType | undefined;
  /**
   * Adds a node; returns a function giving its output ports (by default its
   * only output).
   */
  add(
    type: string,
    params?: StaticParams,
    inputs?: Readonly<Record<string, ValueSource | ConstantValue | undefined>>
  ): (port?: string) => ValueSource;
  /** Whether a node type has an input port. */
  hasInput(type: string, port: string): boolean;
  /**
   * A static parameter: a feature of the material, a declared parameter of
   * the graph, or 'hasAttribute.<semantic>'. Reading it adds it to the
   * variant key of the program.
   */
  feature(name: string): StaticValue | undefined;
}

/**
 * A node evaluated at compile time: it is replaced by the nodes it generates.
 * Macros read static parameters with {@link MacroContext.feature}.
 *
 * @example A macro choosing a color from a feature
 * ```ts
 * const warmOrCold: MacroDefinition = {
 *   id: 'my.warmOrCold',
 *   category: 'macro',
 *   inputs: () => [],
 *   outputs: () => [{ name: 'color', type: BuiltinTypes.vec3f }],
 *   expand: (context) => ({
 *     color: { value: context.feature('warm') ? [1, 0.5, 0] : [0, 0.5, 1] },
 *   }),
 * };
 * ```
 *
 * @group Node definitions
 */
export interface MacroDefinition extends NodeDefinition {
  readonly category: 'macro';
  /** The value of each output of the macro. */
  expand(context: MacroContext): Readonly<Record<string, ValueSource>>;
}

/**
 * Whether a node type is a macro.
 *
 * @group Node definitions
 */
export function isMacroDefinition(
  definition: NodeDefinition
): definition is MacroDefinition {
  return definition.category === 'macro';
}

/**
 * Whether a node type is a function.
 *
 * @group Node definitions
 */
export function isFunctionDefinition(
  definition: NodeDefinition
): definition is FunctionDefinition {
  return definition.category === 'function';
}

/**
 * Resolves the parameters of a node: declared defaults, then the node values.
 *
 * @group Node definitions
 */
export function resolveParams(
  definition: NodeDefinition,
  params: StaticParams
): StaticParams {
  const resolved: Record<string, StaticValue> = {};
  for (const [name, schema] of Object.entries(definition.params ?? {})) {
    if (schema.default !== undefined) {
      resolved[name] = schema.default;
    }
  }
  return { ...resolved, ...params };
}
