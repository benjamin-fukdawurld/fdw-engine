import {
  isFloatScalarKind,
  isNumericScalarKind,
  ScalarKind,
  ShaderType,
  typeToString,
  VectorSize,
} from './ShaderType';

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
export type TypeConstraint = (typeof TypeConstraintNames)[number];

export type GenericPortType = {
  readonly kind: 'generic';
  readonly name: string;
  readonly constraint: TypeConstraint;
};

// The scalar type of a generic: f32 for T = vec3<f32>.
export type ElementOfPortType = {
  readonly kind: 'element-of';
  readonly of: string;
};

// A vector built from the scalar type of a generic: vec2<f32> for T = vec3<f32>.
export type VectorOfPortType = {
  readonly kind: 'vector-of';
  readonly of: string;
  readonly size: VectorSize;
};

export type PortType =
  | ShaderType
  | GenericPortType
  | ElementOfPortType
  | VectorOfPortType;

export const generic = (
  name: string,
  constraint: TypeConstraint = 'any'
): GenericPortType => ({ kind: 'generic', name, constraint });

export const elementOf = (of: string): ElementOfPortType => ({
  kind: 'element-of',
  of,
});

export const vectorOf = (of: string, size: VectorSize): VectorOfPortType => ({
  kind: 'vector-of',
  of,
  size,
});

export function isConcretePortType(type: PortType): type is ShaderType {
  return (
    type.kind !== 'generic' &&
    type.kind !== 'element-of' &&
    type.kind !== 'vector-of'
  );
}

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
    default:
      return typeToString(type);
  }
}
