import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';
import type {
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PhysicalUniformMember,
  UniformValue,
} from './PhysicalLayout';

const scalars = ['f32', 'i32', 'u32', 'bool'];

// Alignment and size of a uniform block member, with the std140 rules:
// scalars take 4 bytes, vec2 8, vec3 and vec4 16 (a vec3 is 12 bytes, and a
// scalar can follow it); a matrix is an array of column vectors, and every
// array element is aligned to 16 bytes.
function std140(type: ShaderType): { align: number; size: number } {
  if (type.kind === 'array' && type.length !== undefined) {
    return { align: 16, size: arrayStride(type.element) * type.length };
  }
  if (type.kind === 'scalar' && scalars.includes(type.scalar)) {
    return { align: 4, size: 4 };
  }
  if (type.kind === 'vector' && scalars.includes(type.scalar)) {
    return { align: type.size === 2 ? 8 : 16, size: type.size * 4 };
  }
  if (type.kind === 'matrix' && type.scalar === 'f32') {
    return { align: 16, size: type.columns * 16 };
  }
  throw new Error(
    `${typeToString(type)} is not supported in a std140 uniform block`,
  );
}

const alignTo = (offset: number, align: number) =>
  Math.ceil(offset / align) * align;

const arrayStride = (element: ShaderType) => alignTo(std140(element).size, 16);

// The stride of the elements of a storage buffer, with the std430 rules:
// as std140, without rounding the array elements up to 16 bytes (a vec3
// still takes 16).
const storageStride = (element: ShaderType) => {
  const { align, size } = std140(element);
  return alignTo(size, align);
};

function uniformBlock(
  resource: Extract<LogicalBinding, { kind: 'uniform-block' }>,
): PhysicalUniformBlock {
  let offset = 0;
  const members = resource.members.map((member) => {
    const { align, size } = std140(member.type);
    offset = alignTo(offset, align);
    const physical = { name: member.name, type: member.type, offset, size };
    offset += size;
    return physical;
  });
  // The block size is rounded up to the alignment of a vec4.
  return { size: Math.max(16, alignTo(offset, 16)), members };
}

/**
 * The layout of a row of an object table, the same on every backend: the
 * members laid out as a std140 uniform block (a mat3 as three columns of
 * vec4), the row size a multiple of 16 bytes. For the world and normal
 * matrices: 112 bytes, the layout of the object uniform block and of the
 * blocks of a TransformPool, so that rows are copied as they are.
 */
export function objectRowLayout(
  members: readonly { readonly name: string; readonly type: ShaderType }[],
): PhysicalUniformBlock {
  return uniformBlock({ kind: 'uniform-block', name: 'row', members });
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

function writeUniform(
  target: DataView,
  { name, type, offset }: PhysicalUniformMember,
  value: UniformValue,
): void {
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
      const source = components(type.columns * type.rows);
      // Packed (9 floats for a mat3) or with padded columns (12 floats, as
      // produced by wgpu-matrix).
      const sourceStride =
        source.length >= type.columns * 4 && type.rows === 3 ? 4 : type.rows;
      for (let column = 0; column < type.columns; column++) {
        for (let row = 0; row < type.rows; row++) {
          target.setFloat32(
            offset + column * 16 + row * 4,
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
      const stride = arrayStride(element);
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
}

/**
 * The layout of the GLSL family (OpenGL, WebGL2, Vulkan): the groups and
 * bindings of the logical layout are kept as they are, uniform blocks are
 * laid out with the std140 rules, storage buffers with the std430 ones.
 * WebGL2 maps the groups and bindings to uniform buffer binding points and
 * texture units; Vulkan uses them as descriptor sets and bindings.
 */
export const std140LayoutStrategy: PhysicalLayoutStrategy = {
  resolve(layout): PhysicalProgramLayout {
    return {
      groups: layout.groups.map((group, index) => ({
        index,
        slot: group.slot,
        bindings: group.bindings.map((resource, binding) =>
          resource.kind === 'uniform-block'
            ? { binding, resource, block: uniformBlock(resource) }
            : resource.kind === 'object-table'
              ? {
                  binding,
                  resource,
                  objectRow: objectRowLayout(resource.members),
                }
              : resource.kind === 'storage-buffer'
                ? {
                    binding,
                    resource,
                    storage: {
                      elementStride: storageStride(resource.type.element),
                    },
                  }
                : { binding, resource },
        ),
      })),
    };
  },
  writeUniform,
};
