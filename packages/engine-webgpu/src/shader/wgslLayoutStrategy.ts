import {
  objectRowLayout,
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  uniformWriter,
} from '@fdw/engine-backend';
import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';

/**
 * The binding numbers of an acceleration structure: the top level, the
 * bottom levels (see SoftwareTopLevel).
 */
export const AccelerationStructureBindings = 2;

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
    `${typeToString(type)} is not supported in a WGSL uniform block`,
  );
}

function arrayStride(element: ShaderType): number {
  const { align, size } = uniformLayoutOf(element);
  const stride = roundUp(size, align);
  if (stride % 16 !== 0) {
    throw new Error(
      `array<${typeToString(
        element,
      )}> needs a stride multiple of 16 in a WGSL uniform block`,
    );
  }
  return stride;
}

function storageStride(element: ShaderType): number {
  const { align, size } = uniformLayoutOf(element);
  return roundUp(size, align);
}

function uniformBlock(
  resource: Extract<LogicalBinding, { kind: 'uniform-block' }>,
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

// Array elements at their uniform stride; the columns of a matrix aligned
// like vectors: 8 bytes for 2 rows, 16 for 3 or 4.
const writeUniform = uniformWriter({
  arrayStride,
  matrixColumnStride: (rows) => (rows === 2 ? 8 : 16),
});

// The layout of a struct in the storage address space: as in the uniform
// one, without rounding the array elements up to 16 bytes.
function storageLayoutOf(type: ShaderType): { align: number; size: number } {
  if (type.kind === 'array' && type.length !== undefined) {
    return {
      align: uniformLayoutOf(type.element).align,
      size: storageStride(type.element) * type.length,
    };
  }
  return uniformLayoutOf(type);
}

/**
 * The row of an object table: laid out as a std140 block (objectRowLayout,
 * the layout of the rows written by the renderer), but read by the programs
 * as a struct of a storage array (WgslCodegen). Both must match, member
 * offsets and row size (the stride of the array), or the rows are misread.
 */
function objectRow(
  resource: Extract<LogicalBinding, { kind: 'object-table' }>,
): PhysicalUniformBlock {
  const row = objectRowLayout(resource.members);
  let offset = 0;
  let structAlign = 1;
  resource.members.forEach((member, i) => {
    const { align, size } = storageLayoutOf(member.type);
    offset = roundUp(offset, align);
    structAlign = Math.max(structAlign, align);
    if (offset !== row.members[i].offset) {
      throw new Error(
        `Object table "${resource.name}": member "${member.name}" is at ${row.members[i].offset} in the rows written, at ${offset} in the WGSL struct`,
      );
    }
    offset += size;
  });
  const size = roundUp(offset, structAlign);
  if (size !== row.size) {
    throw new Error(
      `Object table "${resource.name}": rows of ${row.size} bytes written, of ${size} bytes in the WGSL struct`,
    );
  }
  return row;
}

// WGSL: one bind group per slot, bindings numbered in layout order, uniform
// blocks laid out with the rules of the uniform address space. Elements of
// storage arrays are aligned like in the storage address space: a vec3 takes
// 16 bytes, but scalars and vec2 are not rounded up to 16 as in uniforms.
// An object table takes two binding numbers (rows, instances), an
// acceleration structure two (its BVH in storage buffers, see
// SoftwareTopLevel).
export const wgslLayoutStrategy: PhysicalLayoutStrategy = {
  resolve(layout): PhysicalProgramLayout {
    return {
      groups: layout.groups.map((group, index) => {
        let next = 0;
        return {
          index,
          slot: group.slot,
          bindings: group.bindings.map((resource) => {
            const binding = next;
            next +=
              resource.kind === 'object-table'
                ? 2
                : resource.kind === 'acceleration-structure'
                  ? AccelerationStructureBindings
                  : 1;
            return resource.kind === 'uniform-block'
              ? { binding, resource, block: uniformBlock(resource) }
              : resource.kind === 'object-table'
                ? {
                    binding,
                    resource,
                    objectRow: objectRow(resource),
                  }
                : resource.kind === 'storage-buffer'
                  ? {
                      binding,
                      resource,
                      storage: {
                        elementStride: storageStride(resource.type.element),
                      },
                    }
                  : { binding, resource };
          }),
        };
      }),
    };
  },
  writeUniform,
};
