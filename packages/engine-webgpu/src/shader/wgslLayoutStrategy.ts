import type {
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PhysicalUniformMember,
  UniformValue,
} from '@fdw/engine-backend';
import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';

const roundUp = (value: number, align: number) =>
  Math.ceil(value / align) * align;

const scalars = ['f32', 'i32', 'u32'];

// Alignment and size of a type in the uniform address space of WGSL.
// vec3 is aligned like vec4 but takes 12 bytes: a scalar can follow it.
// Matrices are arrays of column vectors; array elements must be 16-byte
// aligned in uniform buffers.
function uniformLayoutOf(type: ShaderType): { align: number; size: number } {
  if (type.kind === 'scalar' && scalars.includes(type.scalar)) {
    return { align: 4, size: 4 };
  }
  if (type.kind === 'vector' && scalars.includes(type.scalar)) {
    return { align: type.size === 2 ? 8 : 16, size: type.size * 4 };
  }
  if (type.kind === 'matrix' && type.scalar === 'f32') {
    const column = type.rows === 2 ? 8 : 16;
    return { align: column, size: type.columns * column };
  }
  if (type.kind === 'array' && type.length !== undefined) {
    const stride = arrayStride(type.element);
    return {
      align: roundUp(uniformLayoutOf(type.element).align, 16),
      size: stride * type.length,
    };
  }
  throw new Error(
    `${typeToString(type)} is not supported in a WGSL uniform block`
  );
}

function arrayStride(element: ShaderType): number {
  const { align, size } = uniformLayoutOf(element);
  const stride = roundUp(size, align);
  if (stride % 16 !== 0) {
    throw new Error(
      `array<${typeToString(
        element
      )}> needs a stride multiple of 16 in a WGSL uniform block`
    );
  }
  return stride;
}

function storageStride(element: ShaderType): number {
  const { align, size } = uniformLayoutOf(element);
  return roundUp(size, align);
}

function uniformBlock(
  resource: Extract<LogicalBinding, { kind: 'uniform-block' }>
): PhysicalUniformBlock {
  let offset = 0;
  let blockAlign = 16;
  const members = resource.members.map((member) => {
    const { align, size } = uniformLayoutOf(member.type);
    offset = roundUp(offset, align);
    blockAlign = Math.max(blockAlign, align);
    const physical = { name: member.name, type: member.type, offset, size };
    offset += size;
    return physical;
  });
  return { size: roundUp(Math.max(offset, 1), blockAlign), members };
}

function writeScalar(
  target: DataView,
  offset: number,
  scalar: string,
  value: number | boolean
): void {
  const number = typeof value === 'boolean' ? Number(value) : value;
  switch (scalar) {
    case 'i32':
      target.setInt32(offset, number, true);
      return;
    case 'u32':
      target.setUint32(offset, number, true);
      return;
    default:
      target.setFloat32(offset, number, true);
  }
}

function writeUniform(
  target: DataView,
  { name, type, offset }: PhysicalUniformMember,
  value: UniformValue
): void {
  const components = (count: number): ArrayLike<number> => {
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value.length < count
    ) {
      throw new Error(
        `Uniform "${name}" expects ${count} components (${typeToString(type)})`
      );
    }
    return value;
  };

  switch (type.kind) {
    case 'scalar':
      if (typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(
          `Uniform "${name}" expects a number (${typeToString(type)})`
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
      // Columns are aligned like vectors: 8 bytes for 2 rows, 16 for 3 or 4.
      const columnStride = type.rows === 2 ? 8 : 16;
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
            true
          );
        }
      }
      return;
    }
    case 'array': {
      // Elements one after the other in the value, each written at its
      // stride; a shorter value fills the first elements.
      const source = Array.from(value as ArrayLike<number>);
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
          `Uniform "${name}": ${typeToString(type)} values are not supported`
        );
      }
      const stride = arrayStride(element);
      const length = Math.min(
        type.length ?? 0,
        Math.floor(source.length / count)
      );
      for (let i = 0; i < length; i++) {
        writeUniform(
          target,
          { name, type: element, offset: offset + i * stride, size: stride },
          source.slice(i * count, (i + 1) * count)
        );
      }
      return;
    }
    default:
      throw new Error(`${typeToString(type)} uniforms are not supported`);
  }
}

// WGSL: one bind group per slot, bindings numbered in layout order, uniform
// blocks laid out with the rules of the uniform address space. Elements of
// storage arrays are aligned like in the storage address space: a vec3 takes
// 16 bytes, but scalars and vec2 are not rounded up to 16 as in uniforms.
export const wgslLayoutStrategy: PhysicalLayoutStrategy = {
  resolve(layout): PhysicalProgramLayout {
    return {
      groups: layout.groups.map((group, index) => ({
        index,
        slot: group.slot,
        bindings: group.bindings.map((resource, binding) =>
          resource.kind === 'uniform-block'
            ? { binding, resource, block: uniformBlock(resource) }
            : resource.kind === 'storage-buffer'
            ? {
                binding,
                resource,
                storage: {
                  elementStride: storageStride(resource.type.element),
                },
              }
            : { binding, resource }
        ),
      })),
    };
  },
  writeUniform,
};
