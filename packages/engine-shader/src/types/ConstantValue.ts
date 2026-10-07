import {
  isFloatScalarKind,
  ScalarKind,
  ShaderType,
  BuiltinTypes,
  vec,
  VectorSize,
} from './ShaderType';

// An untyped literal. Its type comes from the port it is attached to: 1 can be
// an f32, an i32 or, through scalar splat, a vec3<f32>.
export type ConstantValue = number | boolean | readonly number[];

// The type a literal gets when nothing else gives it one (e.g. an unconnected
// generic input): numbers are f32, arrays of 2 to 4 numbers are float vectors.
export function literalType(value: ConstantValue): ShaderType | undefined {
  if (typeof value === 'boolean') {
    return BuiltinTypes.bool;
  }
  if (typeof value === 'number') {
    return BuiltinTypes.f32;
  }
  if (value.length >= 2 && value.length <= 4) {
    return vec(value.length as VectorSize, 'f32');
  }
  return undefined;
}

function isScalarLiteralCompatible(value: number | boolean, kind: ScalarKind) {
  if (kind === 'bool') {
    return typeof value === 'boolean';
  }
  if (typeof value !== 'number') {
    return false;
  }
  if (isFloatScalarKind(kind)) {
    return Number.isFinite(value);
  }
  if (kind === 'u32') {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }
  return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
}

// Whether a literal can be used as a value of the given type. A single number
// is accepted for a vector (scalar splat), consistently with port connections.
export function isConstantCompatible(
  value: ConstantValue,
  type: ShaderType
): boolean {
  switch (type.kind) {
    case 'scalar':
      return (
        !Array.isArray(value) &&
        isScalarLiteralCompatible(value as number | boolean, type.scalar)
      );
    case 'vector':
      if (Array.isArray(value)) {
        return (
          value.length === type.size &&
          value.every((component) =>
            isScalarLiteralCompatible(component, type.scalar)
          )
        );
      }
      return isScalarLiteralCompatible(value as number | boolean, type.scalar);
    case 'matrix':
      return (
        Array.isArray(value) &&
        value.length === type.columns * type.rows &&
        value.every((component) => Number.isFinite(component))
      );
    default:
      return false;
  }
}
