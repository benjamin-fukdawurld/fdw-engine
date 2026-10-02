import type {
  GpuType,
  PhysicalLayoutStrategy,
  PhysicalProgramLayout,
  PhysicalUniformBlock,
  PrimitiveApi,
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
};
