import type { NodeId } from '../graph/MaterialGraphData';
import type { ConstantValue } from '../types/ConstantValue';
import type { ShaderType } from '../types/ShaderType';

// Intermediate representation produced by the compiler and translated by the
// code generators. The graph has no control flow, so each entry point is a
// straight list of typed instructions in SSA form: every value is defined
// once, before its uses. The only loops are loop-sum, a structured sum, and
// loop-fold, a loop carrying a state; their bodies are themselves straight
// lists of instructions.

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
  // The row of the object drawn in the object table (vertex stage; the
  // fragment stage receives it as a flat varying).
  | 'object-index'
  | 'frag-coord'
  | 'front-facing'
  // Compute stage, vec3<u32>: position of the thread in the whole grid, in
  // its workgroup, of its workgroup, and the number of workgroups.
  | 'global-invocation-id'
  | 'local-invocation-id'
  | 'workgroup-id'
  | 'num-workgroups';

/**
 * Arithmetic operators.
 *
 * @group Intermediate representation
 */
export type IrBinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  /**
   * Integers only: remainder, bitwise and, or, xor, shifts (the amount is
   * of the type of the value, below its bit count). Unsigned integers wrap
   * around on overflow, on every backend.
   */
  | '%'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>';

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
  | 'step'
  /**
   * The change of a value from a pixel to the next one, to the right
   * (dpdx) or below (dpdy: y points down, as screen-uv and frag-coord in
   * WGSL), and |dpdx| + |dpdy|. Fragment stage only.
   */
  | 'dpdx'
  | 'dpdy'
  | 'fwidth';

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
  /**
   * A member of a row of the object table (the 'object-table' binding of
   * the layout): args[0] is the row, a u32.
   */
  | { readonly kind: 'load-object'; readonly member: string }
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
  /** textureSampleLevel(texture, sampler, uv, level): explicit level. */
  | { readonly kind: 'sample-level' }
  /**
   * textureSampleCompareLevel(texture, sampler, uv, depthRef): compares the
   * reference with the depths of a depth texture around uv (filtered by a
   * comparison sampler), at level 0. The fraction of them that pass.
   */
  | { readonly kind: 'sample-compare' }
  /**
   * textureLoad(texture, coords, level): the texel at integer coordinates
   * (a vec2<i32>, rows from the top) of a level, without sampler nor
   * filtering. A vec4<f32>, or the depth (f32) of a depth texture.
   */
  | { readonly kind: 'texture-load' }
  /** A vector built from its arguments; a single scalar argument is a splat. */
  | { readonly kind: 'construct' }
  | { readonly kind: 'swizzle'; readonly components: string }
  /** Conversion of the scalar kind, component-wise for vectors. */
  | { readonly kind: 'convert' }
  /** array[index]: an element of an array (uniform block member or storage buffer). */
  | { readonly kind: 'index' }
  /** The number of elements of a runtime-sized array (a storage buffer). */
  | { readonly kind: 'array-length' }
  /**
   * The bits of a 32 bits scalar or vector (args[0]) seen as another
   * scalar kind (the type of the instruction): f32 ↔ u32 ↔ i32.
   */
  | { readonly kind: 'bitcast' }
  /**
   * Traces a ray in an acceleration structure: args are the structure, the
   * origin and direction (vec3<f32>), tMin and tMax (f32, in units of the
   * length of the direction) and the mask (u32: the instances sharing a bit
   * with it are seen). `closest` finds the nearest hit, `any` stops at the
   * first one found (shadows, occlusion). The hit, a vec4<u32>: x the
   * instance (0xffffffff without hit), y the triangle in its mesh, with
   * bit 31 set when seen from the back, z and w the bits of the barycentric
   * coordinates u and v (f32: the weights of the second and third vertex).
   */
  | { readonly kind: 'ray-query'; readonly mode: 'closest' | 'any' }
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
    }
  /**
   * A loop carrying a state: state = initial (args[1]), then, for index
   * from 0 to count - 1 (args[0], a u32), state = result, computed by the
   * body from the state and the index. The value is the last state. The
   * body is straight code, as for loop-sum; it may contain other loops.
   */
  | {
      readonly kind: 'loop-fold';
      /** Id of the loop index, a u32 read by the body. */
      readonly index: ValueId;
      /** Id of the state at the start of an iteration, read by the body. */
      readonly state: ValueId;
      readonly body: readonly IrInstruction[];
      /** The state at the end of an iteration. */
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
 * A write of a compute stage: `resource[index] = value`, when `condition`
 * (if any) is true. Writes are results of the stage, made in order after its
 * body, which keeps no side effect.
 *
 * @group Intermediate representation
 */
export interface IrWrite {
  /** Name of a read-write storage buffer of the layout. */
  readonly resource: string;
  /** Index of the element, a u32 or i32. */
  readonly index: ValueId;
  readonly value: ValueId;
  /** A bool: the write is only made when true. */
  readonly condition?: ValueId;
}

/**
 * A stage of a program.
 *
 * @group Intermediate representation
 */
export interface IrEntryPoint {
  readonly stage: 'vertex' | 'fragment' | 'compute';
  /**
   * Vertex attributes for the vertex stage, varyings for the fragment stage;
   * none for the compute stage.
   */
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
  /** Compute stage: the number of threads of a workgroup, in x, y and z. */
  readonly workgroupSize?: readonly [number, number, number];
  /** Compute stage: the writes, made in order after the body. */
  readonly writes?: readonly IrWrite[];
  /**
   * Compute stage: the threads where `value` (a bool) is false skip the
   * rest of the body and write nothing. The first `after` instructions of
   * the body compute it; the code generators test it right after them.
   */
  readonly active?: { readonly value: ValueId; readonly after: number };
}

/**
 * The intermediate representation of a program: a straight list of typed
 * instructions per stage, in SSA form, translated by the code generators. A
 * program has a vertex and a fragment stage, or a single compute stage.
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
  visit: (instruction: IrInstruction) => void,
): void {
  for (const instruction of body) {
    visit(instruction);
    if (
      instruction.op.kind === 'loop-sum' ||
      instruction.op.kind === 'loop-fold'
    ) {
      forEachInstruction(instruction.op.body, visit);
    }
  }
}
