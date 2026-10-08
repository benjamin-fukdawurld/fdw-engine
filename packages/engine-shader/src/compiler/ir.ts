import type { NodeId } from '../graph/MaterialGraphData';
import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

// Intermediate representation produced by the compiler and translated by the
// code generators. The graph has no control flow, so each entry point is a
// straight list of typed instructions in SSA form: every value is defined
// once, before its uses. The only loop is loop-sum, a structured sum whose
// body is itself a straight list of instructions.

/**
 * Id of a value, unique in its entry point.
 *
 * @group Intermediate representation
 */
export type ValueId = number;

/**
 * Values provided by the GPU.
 *
 * @group Intermediate representation
 */
export type IrBuiltin =
  | 'vertex-index'
  | 'instance-index'
  | 'frag-coord'
  | 'front-facing';

/**
 * Arithmetic operators.
 *
 * @group Intermediate representation
 */
export type IrBinaryOperator = '+' | '-' | '*' | '/';

/**
 * Comparison operators: component-wise for vectors, giving booleans.
 *
 * @group Intermediate representation
 */
export type IrComparison = '<' | '<=' | '>' | '>=' | '==' | '!=';

/**
 * Intrinsic functions, with the same semantics in every target language.
 *
 * @group Intermediate representation
 */
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
  | 'saturate'
  | 'step';

/**
 * The operation of an instruction.
 *
 * @group Intermediate representation
 */
export type IrOp =
  /**
   * Scalars are numbers or booleans; vectors and matrices are full arrays of
   * components (column-major), scalar splats are already expanded.
   */
  | { readonly kind: 'constant'; readonly value: ConstantValue }
  /** A stage input: vertex attribute or varying. */
  | { readonly kind: 'load-input'; readonly input: string }
  | { readonly kind: 'load-builtin'; readonly builtin: IrBuiltin }
  /** A binding of the ProgramLayout, or a member of a uniform block. */
  | {
      readonly kind: 'load-resource';
      readonly binding: string;
      readonly member?: string;
    }
  | { readonly kind: 'binary'; readonly operator: IrBinaryOperator }
  | { readonly kind: 'compare'; readonly operator: IrComparison }
  | { readonly kind: 'intrinsic'; readonly name: IrIntrinsic }
  /** select(ifFalse, ifTrue, condition): branchless choice. */
  | { readonly kind: 'select' }
  /** textureSample(texture, sampler, uv), implicit level of detail. */
  | { readonly kind: 'sample' }
  /** A vector built from its arguments; a single scalar argument is a splat. */
  | { readonly kind: 'construct' }
  | { readonly kind: 'swizzle'; readonly components: string }
  /** Conversion of the scalar kind, component-wise for vectors. */
  | { readonly kind: 'convert' }
  /** array[index]: an element of an array read from a uniform block. */
  | { readonly kind: 'index' }
  /**
   * The only loop of the IR: the sum, for index from 0 to count - 1 (args[0],
   * a u32), of the value `result` computed by `body` from `index`. The body
   * is straight code too; it can read the values defined before the loop,
   * and its own values are not visible after it.
   */
  | {
      readonly kind: 'loop-sum';
      /** Id of the loop index, a u32 read by the body. */
      readonly index: ValueId;
      readonly body: readonly IrInstruction[];
      /** The value of the body summed over the iterations. */
      readonly result: ValueId;
    };

/**
 * An instruction: defines one value from its arguments.
 *
 * @group Intermediate representation
 */
export interface IrInstruction {
  /** The value defined by the instruction. */
  readonly id: ValueId;
  /** Type of the value. */
  readonly type: ShaderType;
  /** The operation. */
  readonly op: IrOp;
  /** The values the operation reads. */
  readonly args: readonly ValueId[];
  /** Derived from the node label, for readable generated code. */
  readonly name?: string;
  /** The graph node the instruction comes from, for debugging. */
  readonly sourceNode?: NodeId;
}

/**
 * An input or output of a stage.
 *
 * @group Intermediate representation
 */
export interface IrStageVariable {
  readonly name: string;
  readonly type: ShaderType;
  readonly location?: number;
  readonly builtin?: 'position';
  /** Integers cannot be interpolated between vertices. */
  readonly interpolation?: 'perspective' | 'flat';
}

/**
 * A stage of a program.
 *
 * @group Intermediate representation
 */
export interface IrEntryPoint {
  readonly stage: 'vertex' | 'fragment';
  /** Vertex attributes for the vertex stage, varyings for the fragment stage. */
  readonly inputs: readonly IrStageVariable[];
  /**
   * Clip position and varyings for the vertex stage, color targets for the
   * fragment stage.
   */
  readonly outputs: readonly IrStageVariable[];
  /** The instructions, in execution order. */
  readonly body: readonly IrInstruction[];
  /**
   * Value written to each output, by output name. The fragment stage can also
   * have a `discard` result: a boolean abandoning the fragment when true.
   * It is a result rather than an instruction, so that the body keeps no side
   * effect; the code generators test it after the whole body, just before
   * writing the color (after every texture sample, as derivatives need the
   * neighboring fragments).
   */
  readonly results: Readonly<Record<string, ValueId>>;
}

/**
 * The intermediate representation of a program: a straight list of typed
 * instructions per stage, in SSA form, translated by the code generators.
 *
 * @group Intermediate representation
 */
export interface ShaderModuleIR {
  /** Name of the graph. */
  readonly name: string;
  /** The vertex and fragment stages. */
  readonly entryPoints: readonly IrEntryPoint[];
}

/**
 * Calls a function on every instruction of a body, those of the loop bodies
 * included, in order.
 *
 * @group Intermediate representation
 */
export function forEachInstruction(
  body: readonly IrInstruction[],
  visit: (instruction: IrInstruction) => void
): void {
  for (const instruction of body) {
    visit(instruction);
    if (instruction.op.kind === 'loop-sum') {
      forEachInstruction(instruction.op.body, visit);
    }
  }
}
