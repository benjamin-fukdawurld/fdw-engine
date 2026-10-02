import type {
  GpuType,
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PhysicalUniformMember,
  PrimitiveApi,
  UniformValue,
} from '@fdw/engine-backend';
import { LogicalBinding, ShaderType, typeToString } from '@fdw/engine-shader';
import { uniformPrimitives } from '../gpu/primitives';
import { uniformStructBuilder } from '../gpu/structs';

const vectorSuffix = { f32: '', i32: 'i', u32: 'u' } as const;

// The GPU memory type of a uniform block member.
function uniformTypeOf(type: ShaderType): GpuType<unknown> {
  const primitive = (name: keyof PrimitiveApi) =>
    uniformPrimitives[name] as GpuType<unknown>;

  if (type.kind === 'scalar') {
    switch (type.scalar) {
      case 'f32':
        return primitive('float32');
      case 'i32':
        return primitive('int32');
      case 'u32':
        return primitive('uint32');
    }
  }
  if (type.kind === 'vector' && type.scalar in vectorSuffix) {
    const suffix = vectorSuffix[type.scalar as keyof typeof vectorSuffix];
    return primitive(`vec${type.size}${suffix}` as keyof PrimitiveApi);
  }
  if (
    type.kind === 'matrix' &&
    type.scalar === 'f32' &&
    type.columns === type.rows
  ) {
    return primitive(`mat${type.columns}` as keyof PrimitiveApi);
  }
  throw new Error(
    `${typeToString(type)} is not supported in a WGSL uniform block`
  );
}

function uniformBlock(
  resource: Extract<LogicalBinding, { kind: 'uniform-block' }>
): PhysicalUniformBlock {
  const struct = uniformStructBuilder(
    resource.members.map((member) => ({
      name: member.name,
      type: uniformTypeOf(member.type),
    }))
  );
  return {
    size: struct.size,
    members: resource.members.map((member, i) => ({
      name: member.name,
      type: member.type,
      offset: struct.fields[i].offset,
      size: uniformTypeOf(member.type).size,
    })),
  };
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
    default:
      throw new Error(`${typeToString(type)} uniforms are not supported`);
  }
}

// WGSL: one bind group per slot, bindings numbered in layout order, uniform
// blocks laid out with the rules of the uniform address space.
export const wgslLayoutStrategy: PhysicalLayoutStrategy = {
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
