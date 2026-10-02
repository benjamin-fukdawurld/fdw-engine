import type { ConstantValue } from '../types/ConstantValue';
import type { PortType } from '../types/PortType';
import type { ShaderType } from '../types/ShaderType';
import type {
  GraphNode,
  MaterialGraphData,
  StaticValue,
  ValueSource,
} from './MaterialGraphData';

export const NodeCategoryNames = [
  'input',
  'constant',
  'function',
  'macro',
  'output',
] as const;
export type NodeCategory = (typeof NodeCategoryNames)[number];

export type ShaderStage = 'vertex' | 'fragment';

export interface PortSchema {
  readonly name: string;
  readonly type: PortType;
  // Value used when the input is not connected.
  readonly default?: ConstantValue;
  // An optional input can stay unconnected without a default value.
  readonly optional?: boolean;
}

export type ParamKind = 'string' | 'number' | 'boolean' | 'type' | 'constant';

export interface ParamSchema {
  readonly kind: ParamKind;
  // Allowed values, for string parameters.
  readonly values?: readonly string[];
  readonly default?: StaticValue;
  readonly required?: boolean;
}

export type StaticParams = Readonly<Record<string, StaticValue>>;

export interface NodeDefinition {
  // 'std.mul', 'input.uniform'…
  readonly id: string;
  readonly category: NodeCategory;
  readonly description?: string;
  // Compile-time parameters.
  readonly params?: Readonly<Record<string, ParamSchema>>;
  // Ports can depend on the parameters: the output of 'input.uniform' has the
  // type given by its 'type' parameter.
  inputs(params: StaticParams): readonly PortSchema[];
  outputs(params: StaticParams): readonly PortSchema[];
  // Restricts the node to a stage (derivatives, implicit-LOD sampling…).
  stage?(params: StaticParams): ShaderStage | undefined;
}

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
  // Returns its input unchanged: used to force a computation per fragment.
  | 'identity'
  | 'select'
  | 'construct'
  | 'convert'
  | 'texture-sample';

// Code provided per shading language. Breaks portability: compilation fails
// for a backend whose language has no implementation.
export type NativeShaderLanguage =
  | 'wgsl'
  | 'glsl-es-300'
  | 'glsl-450'
  | 'msl'
  | 'hlsl';

export type FunctionImplementation =
  // An IR operation that every code generator knows how to translate.
  | { readonly kind: 'intrinsic'; readonly op: IntrinsicOp }
  // Defined by a subgraph, emitted as a function of the target language.
  | { readonly kind: 'graph'; readonly graph: MaterialGraphData }
  | {
      readonly kind: 'native';
      readonly sources: Readonly<Partial<Record<NativeShaderLanguage, string>>>;
    };

export interface FunctionDefinition extends NodeDefinition {
  readonly category: 'function';
  readonly implementation: FunctionImplementation;
}

// What a macro can do while it is expanded.
export interface MacroContext {
  readonly node: GraphNode;
  readonly params: StaticParams;
  // The value feeding an input: its edge, the node default or the port
  // default; undefined for an unconnected optional input.
  input(port: string): ValueSource | undefined;
  // Concrete type of an input or output port of the macro node.
  typeOf(port: string): ShaderType | undefined;
  // Adds a node; returns a function giving its output ports (by default its
  // only output).
  add(
    type: string,
    params?: StaticParams,
    inputs?: Readonly<Record<string, ValueSource | ConstantValue | undefined>>
  ): (port?: string) => ValueSource;
  // Whether a node type has an input port.
  hasInput(type: string, port: string): boolean;
  // A static parameter: a feature of the material, a declared parameter of
  // the graph, or 'hasAttribute.<semantic>'. Reading it adds it to the
  // variant key of the program.
  feature(name: string): StaticValue | undefined;
}

// A node evaluated at compile time: it is replaced by the nodes it generates.
export interface MacroDefinition extends NodeDefinition {
  readonly category: 'macro';
  // The value of each output of the macro.
  expand(context: MacroContext): Readonly<Record<string, ValueSource>>;
}

export function isMacroDefinition(
  definition: NodeDefinition
): definition is MacroDefinition {
  return definition.category === 'macro';
}

export function isFunctionDefinition(
  definition: NodeDefinition
): definition is FunctionDefinition {
  return definition.category === 'function';
}

// Resolves the parameters of a node: declared defaults, then the node values.
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
