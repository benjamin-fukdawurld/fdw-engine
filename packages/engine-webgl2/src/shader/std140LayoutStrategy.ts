import type {
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PhysicalUniformMember,
  UniformValue,
} from '@fdw/engine-backend';
import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';

const scalars = ['f32', 'i32', 'u32', 'bool'];

// Alignment and size of a uniform block member, with the std140 rules:
// scalars take 4 bytes, vec2 8, vec3 and vec4 16 (a vec3 is 12 bytes, and a
// scalar can follow it); a matrix is an array of column vectors, each one
// aligned to 16 bytes.
function std140(type: ShaderType): { align: number; size: number } {
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
    `${typeToString(type)} is not supported in a GLSL uniform block`
  );
}

const alignTo = (offset: number, align: number) =>
  Math.ceil(offset / align) * align;

function uniformBlock(
  resource: Extract<LogicalBinding, { kind: 'uniform-block' }>
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
            true
          );
        }
      }
      return;
    }
    default:
      throw new Error(`${typeToString(type)} uniforms are not supported`);
  }
}

// GLSL ES: the groups and bindings of the logical layout are kept, the
// pipeline maps them to uniform buffer binding points and texture units.
// Uniform blocks are laid out with the std140 rules.
export const std140LayoutStrategy: PhysicalLayoutStrategy = {
  resolve(layout): PhysicalProgramLayout {
    return {
      groups: layout.groups.map((group, index) => ({
        index,
        slot: group.slot,
        bindings: group.bindings.map((resource, binding) =>
          resource.kind === 'uniform-block'
            ? { binding, resource, block: uniformBlock(resource) }
            : { binding, resource }
        ),
      })),
    };
  },
  writeUniform,
};
