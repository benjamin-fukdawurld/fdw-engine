import type { NodeId } from '../graph/MaterialGraphData';
import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

// Intermediate representation produced by the compiler and translated by the
// code generators. The graph has no control flow, so each entry point is a
// straight list of typed instructions in SSA form: every value is defined
// once, before its uses.

export type ValueId = number;

export type IrBuiltin =
  | 'vertex-index'
  | 'instance-index'
  | 'frag-coord'
  | 'front-facing';

export type IrBinaryOperator = '+' | '-' | '*' | '/';

// Intrinsic functions, with the same semantics in every target language.
export type IrIntrinsic =
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
  | 'saturate';

export type IrOp =
  // Scalars are numbers or booleans; vectors and matrices are full arrays of
  // components (column-major), scalar splats are already expanded.
  | { readonly kind: 'constant'; readonly value: ConstantValue }
  // A stage input: vertex attribute or varying.
  | { readonly kind: 'load-input'; readonly input: string }
  | { readonly kind: 'load-builtin'; readonly builtin: IrBuiltin }
  // A binding of the ProgramLayout, or a member of a uniform block.
  | {
      readonly kind: 'load-resource';
      readonly binding: string;
      readonly member?: string;
    }
  | { readonly kind: 'binary'; readonly operator: IrBinaryOperator }
  | { readonly kind: 'intrinsic'; readonly name: IrIntrinsic }
  // select(ifFalse, ifTrue, condition): branchless choice.
  | { readonly kind: 'select' }
  // textureSample(texture, sampler, uv), implicit level of detail.
  | { readonly kind: 'sample' }
  // A vector built from its arguments; a single scalar argument is a splat.
  | { readonly kind: 'construct' }
  | { readonly kind: 'swizzle'; readonly components: string }
  // Conversion of the scalar kind, component-wise for vectors.
  | { readonly kind: 'convert' };

export interface IrInstruction {
  readonly id: ValueId;
  readonly type: ShaderType;
  readonly op: IrOp;
  readonly args: readonly ValueId[];
  // Derived from the node label, for readable generated code.
  readonly name?: string;
  // The graph node the instruction comes from, for debugging.
  readonly sourceNode?: NodeId;
}

export interface IrStageVariable {
  readonly name: string;
  readonly type: ShaderType;
  readonly location?: number;
  readonly builtin?: 'position';
  // Integers cannot be interpolated between vertices.
  readonly interpolation?: 'perspective' | 'flat';
}

export interface IrEntryPoint {
  readonly stage: 'vertex' | 'fragment';
  // Vertex attributes for the vertex stage, varyings for the fragment stage.
  readonly inputs: readonly IrStageVariable[];
  // Clip position and varyings for the vertex stage, color targets for the
  // fragment stage.
  readonly outputs: readonly IrStageVariable[];
  readonly body: readonly IrInstruction[];
  // Value written to each output, by output name.
  readonly results: Readonly<Record<string, ValueId>>;
}

export interface ShaderModuleIR {
  readonly name: string;
  readonly entryPoints: readonly IrEntryPoint[];
}
