import { ShaderType, vec, VectorSize } from '../types/ShaderType';

const componentSets = ['xyzw', 'rgba'] as const;

/**
 * Indices of the components selected by a swizzle ('zx' → [2, 0]), or
 * undefined if the swizzle is malformed. Mixing component sets ('xg') is not
 * allowed, as in WGSL and GLSL.
 *
 * @group Validation
 */
export function parseSwizzle(swizzle: string): number[] | undefined {
  if (swizzle.length < 1 || swizzle.length > 4) {
    return undefined;
  }
  for (const set of componentSets) {
    const indices = [...swizzle].map((component) => set.indexOf(component));
    if (indices.every((index) => index >= 0)) {
      return indices;
    }
  }
  return undefined;
}

/**
 * Type of a swizzled value. Only vectors can be swizzled.
 *
 * @group Validation
 */
export function swizzleType(
  type: ShaderType,
  swizzle: string,
): ShaderType | string {
  if (type.kind !== 'vector') {
    return `cannot swizzle a value of kind ${type.kind}`;
  }
  const indices = parseSwizzle(swizzle);
  if (!indices) {
    return `invalid swizzle ".${swizzle}"`;
  }
  if (indices.some((index) => index >= type.size)) {
    return `swizzle ".${swizzle}" is out of range for a vec${type.size}`;
  }
  return indices.length === 1
    ? { kind: 'scalar', scalar: type.scalar }
    : vec(indices.length as VectorSize, type.scalar);
}

/**
 * Applying `outer` to a value already swizzled by `inner`: 'xyz' then 'zx'
 * gives 'zx', 'wzy' then 'x' gives 'w'.
 *
 * @group Validation
 */
export function composeSwizzles(
  inner: string,
  outer: string,
): string | undefined {
  const innerIndices = parseSwizzle(inner);
  const outerIndices = parseSwizzle(outer);
  if (!innerIndices || !outerIndices) {
    return undefined;
  }
  if (outerIndices.some((index) => index >= innerIndices.length)) {
    return undefined;
  }
  return outerIndices.map((index) => 'xyzw'[innerIndices[index]]).join('');
}
