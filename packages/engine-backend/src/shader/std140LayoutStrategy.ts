import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';
import type {
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
} from './PhysicalLayout';
import { uniformWriter } from './uniformWriter';

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

// Matrix columns and array elements are 16 bytes apart.
const writeUniform = uniformWriter({
  arrayStride,
  matrixColumnStride: () => 16,
});

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
