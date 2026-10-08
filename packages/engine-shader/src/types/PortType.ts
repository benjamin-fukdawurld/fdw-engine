import {
  isFloatScalarKind,
  isNumericScalarKind,
  ScalarKind,
  ShaderType,
  typeToString,
  VectorSize,
} from './ShaderType';

/**
 * Constraints a generic port type can have.
 *
 * @group Port types
 */
export const TypeConstraintNames = [
  'any',
  // Scalars and vectors, except bool.
  'numeric',
  // f32 / f16 scalars and vectors.
  'float',
  'float-vector',
  // i32 / u32 scalars and vectors.
  'integer',
] as const;
/**
 * A constraint on the type bound to a generic:
 * - `any`: any type;
 * - `numeric`: scalars and vectors, except `bool`;
 * - `float`: `f32` / `f16` scalars and vectors;
 * - `float-vector`: `f32` / `f16` vectors;
 * - `integer`: `i32` / `u32` scalars and vectors.
 *
 * @group Port types
 */
export type TypeConstraint = (typeof TypeConstraintNames)[number];

/**
 * A type variable: ports sharing the same generic name get the same type,
 * inferred from what is connected to them.
 *
 * @group Port types
 */
export type GenericPortType = {
  readonly kind: 'generic';
  readonly name: string;
  readonly constraint: TypeConstraint;
};

/**
 * The scalar type of a generic: f32 for T = vec3<f32>.
 *
 * @group Port types
 */
export type ElementOfPortType = {
  readonly kind: 'element-of';
  readonly of: string;
};

/**
 * A vector built from the scalar type of a generic: vec2<f32> for T = vec3<f32>.
 *
 * @group Port types
 */
export type VectorOfPortType = {
  readonly kind: 'vector-of';
  readonly of: string;
  readonly size: VectorSize;
};

/**
 * A boolean of the shape of a generic: `bool` for `T = f32`, `vec3<bool>`
 * for `T = vec3<f32>`. The result of a component-wise comparison.
 *
 * @group Port types
 */
export type BoolOfPortType = {
  readonly kind: 'bool-of';
  readonly of: string;
};

/**
 * The type of a port in a node definition: a concrete shader type, or a type
 * derived from a generic.
 *
 * @group Port types
 */
export type PortType =
  | ShaderType
  | GenericPortType
  | ElementOfPortType
  | VectorOfPortType
  | BoolOfPortType;

/**
 * Creates a generic port type.
 *
 * @example
 * ```ts
 * // add<T: numeric>(a: T, b: T) -> T
 * const numeric = generic('T', 'numeric');
 * ```
 *
 * @group Port types
 */
export const generic = (
  name: string,
  constraint: TypeConstraint = 'any'
): GenericPortType => ({ kind: 'generic', name, constraint });

/**
 * The scalar type of a generic: `f32` for `T = vec3<f32>`.
 *
 * @group Port types
 */
export const elementOf = (of: string): ElementOfPortType => ({
  kind: 'element-of',
  of,
});

/**
 * A vector of the scalar type of a generic: `vec2<f32>` for `T = vec3<f32>`.
 *
 * @group Port types
 */
export const vectorOf = (of: string, size: VectorSize): VectorOfPortType => ({
  kind: 'vector-of',
  of,
  size,
});

/**
 * A boolean of the shape of a generic: `vec3<bool>` for `T = vec3<f32>`.
 *
 * @group Port types
 */
export const boolOf = (of: string): BoolOfPortType => ({ kind: 'bool-of', of });

/**
 * Whether a port type is a concrete shader type.
 *
 * @group Port types
 */
export function isConcretePortType(type: PortType): type is ShaderType {
  return (
    type.kind !== 'generic' &&
    type.kind !== 'element-of' &&
    type.kind !== 'vector-of' &&
    type.kind !== 'bool-of'
  );
}

/**
 * The scalar kind of a scalar, vector or matrix type.
 *
 * @group Port types
 */
export function scalarKindOf(type: ShaderType): ScalarKind | undefined {
  switch (type.kind) {
    case 'scalar':
    case 'vector':
    case 'matrix':
      return type.scalar;
    default:
      return undefined;
  }
}

/**
 * Whether a shader type satisfies a generic constraint.
 *
 * @group Port types
 */
export function satisfiesConstraint(
  type: ShaderType,
  constraint: TypeConstraint
): boolean {
  if (constraint === 'any') {
    return true;
  }

  if (type.kind !== 'scalar' && type.kind !== 'vector') {
    return false;
  }

  switch (constraint) {
    case 'numeric':
      return isNumericScalarKind(type.scalar);
    case 'float':
      return isFloatScalarKind(type.scalar);
    case 'float-vector':
      return type.kind === 'vector' && isFloatScalarKind(type.scalar);
    case 'integer':
      return type.scalar === 'i32' || type.scalar === 'u32';
  }
}

/**
 * Readable representation of a port type, for diagnostics.
 *
 * @group Port types
 */
export function portTypeToString(type: PortType): string {
  switch (type.kind) {
    case 'generic':
      return type.constraint === 'any'
        ? type.name
        : `${type.name}: ${type.constraint}`;
    case 'element-of':
      return `element-of<${type.of}>`;
    case 'vector-of':
      return `vec${type.size}<element-of<${type.of}>>`;
    case 'bool-of':
      return `bool-of<${type.of}>`;
    default:
      return typeToString(type);
  }
}
