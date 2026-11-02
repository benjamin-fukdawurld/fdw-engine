import { ShaderType, typeToString } from '@fdw/engine-shader';
import type {
  PhysicalLayoutStrategy,
  PhysicalUniformMember,
  UniformValue,
} from './PhysicalLayout';

/** The strides of a uniform layout that differ between the backends. */
export interface UniformStrides {
  /** The bytes between the elements of an array of this element type. */
  arrayStride(element: ShaderType): number;
  /** The bytes between the columns of a matrix of this many rows. */
  matrixColumnStride(rows: number): number;
}

function writeScalar(
  target: DataView,
  offset: number,
  scalar: string,
  value: number | boolean,
): void {
  const number = typeof value === 'boolean' ? Number(value) : value;
  switch (scalar) {
    case 'i32':
      target.setInt32(offset, number, true);
      return;
    case 'u32':
    case 'bool':
      target.setUint32(offset, number, true);
      return;
    default:
      target.setFloat32(offset, number, true);
  }
}

/**
 * The writeUniform of a layout strategy: scalars, vectors, matrices (from
 * packed or padded columns) and fixed-size arrays of them, written at the
 * strides of the layout.
 */
export function uniformWriter(
  strides: UniformStrides,
): PhysicalLayoutStrategy['writeUniform'] {
  const writeUniform = (
    target: DataView,
    { name, type, offset }: PhysicalUniformMember,
    value: UniformValue,
  ): void => {
    const components = (count: number): ArrayLike<number> => {
      if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value.length < count
      ) {
        throw new Error(
          `Uniform "${name}" expects ${count} components (${typeToString(type)})`,
        );
      }
      return value;
    };

    switch (type.kind) {
      case 'scalar':
        if (typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(
            `Uniform "${name}" expects a number (${typeToString(type)})`,
          );
        }
        writeScalar(target, offset, type.scalar, value);
        return;
      case 'vector': {
        const source = components(type.size);
        for (let i = 0; i < type.size; i++) {
          writeScalar(target, offset + i * 4, type.scalar, source[i]);
        }
        return;
      }
      case 'matrix': {
        const columnStride = strides.matrixColumnStride(type.rows);
        const source = components(type.columns * type.rows);
        // Packed (9 floats for a mat3) or with padded columns (12 floats, as
        // produced by wgpu-matrix).
        const sourceStride =
          source.length >= type.columns * 4 && type.rows === 3 ? 4 : type.rows;
        for (let column = 0; column < type.columns; column++) {
          for (let row = 0; row < type.rows; row++) {
            target.setFloat32(
              offset + column * columnStride + row * 4,
              source[column * sourceStride + row],
              true,
            );
          }
        }
        return;
      }
      case 'array': {
        // Elements one after the other in the value, each written at its
        // stride; a shorter value fills the first elements.
        const element = type.element;
        const count =
          element.kind === 'scalar'
            ? 1
            : element.kind === 'vector'
              ? element.size
              : element.kind === 'matrix'
                ? element.columns * element.rows
                : 0;
        if (count === 0 || typeof value !== 'object') {
          throw new Error(
            `Uniform "${name}": ${typeToString(type)} values are not supported`,
          );
        }
        const source = Array.from(value);
        const stride = strides.arrayStride(element);
        const length = Math.min(
          type.length ?? 0,
          Math.floor(source.length / count),
        );
        for (let i = 0; i < length; i++) {
          writeUniform(
            target,
            { name, type: element, offset: offset + i * stride, size: stride },
            source.slice(i * count, (i + 1) * count),
          );
        }
        return;
      }
      default:
        throw new Error(`${typeToString(type)} uniforms are not supported`);
    }
  };
  return writeUniform;
}
