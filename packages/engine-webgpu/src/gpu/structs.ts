import {
  GpuArray,
  GpuStruct,
  GpuStructField,
  GpuStructFieldBluePrint,
  struct,
  StructBuildStrategy,
} from '@fdw/engine-backend';

type FieldType = GpuStructField<unknown>['type'];

const align = (offset: number, alignment: number): number =>
  Math.ceil(offset / alignment) * alignment;

const isStruct = (type: FieldType): type is GpuStruct<unknown> =>
  'fields' in type;

const isArray = (type: FieldType): type is GpuArray<unknown> =>
  'element' in type;

const isRuntimeSizedArray = (
  field: Omit<GpuStructField<unknown>, 'offset'>,
): boolean => isArray(field.type) && field.type.length === undefined;

// Built structs always define the hasDynamicSize key (possibly undefined),
// so the value must be tested, not the presence of the key.
const isRuntimeSizedStruct = (type: FieldType): boolean =>
  isStruct(type) && type.hasDynamicSize === true;

const naturalAlignment = (type: FieldType): number =>
  isArray(type) ? type.element.alignment : type.alignment;

// WGSL uniform address space rules: array and struct members are aligned to
// 16 bytes, and a struct member occupies a multiple of 16 bytes. WGSL does not
// insert this padding itself, so the serialized members carry explicit
// @align / @size attributes (see uniformMemberAttributes).
const uniformFieldAlignment = (type: FieldType): number =>
  isArray(type) || isStruct(type)
    ? align(naturalAlignment(type), 16)
    : type.alignment;

const uniformFieldSize = (type: FieldType): number => {
  if (isArray(type)) {
    return type.stride * (type.length ?? 1);
  }
  if (isStruct(type)) {
    return align(type.size, 16);
  }
  return type.size;
};

const uniformMemberAttributes = (field: GpuStructField<unknown>): string => {
  const attributes: string[] = [];
  const alignment = uniformFieldAlignment(field.type);
  if (alignment !== naturalAlignment(field.type)) {
    attributes.push(`@align(${alignment})`);
  }
  if (
    isStruct(field.type) &&
    uniformFieldSize(field.type) !== field.type.size
  ) {
    attributes.push(`@size(${uniformFieldSize(field.type)})`);
  }
  return attributes.map((attribute) => `${attribute} `).join('');
};

const serializeStruct = (
  blueprint: GpuStructFieldBluePrint,
  memberAttributes: (field: GpuStructField<unknown>) => string = () => '',
): string => {
  const fields = blueprint.fields
    .map(
      (field) =>
        `${memberAttributes(field)}${field.name}: ${field.type.serialize()}`,
    )
    .join(',\n  ');
  return `{
  ${fields}
}`;
};

const getRuntimeSizedArrayField = (
  blueprint: GpuStructFieldBluePrint,
): GpuStructField<unknown> | undefined => {
  const lastField = blueprint.fields[blueprint.fields.length - 1];
  return lastField && isRuntimeSizedArray(lastField) ? lastField : undefined;
};

const hasDynamicSize = (
  blueprint: GpuStructFieldBluePrint,
): true | undefined => {
  return getRuntimeSizedArrayField(blueprint) ? true : undefined;
};

export const storageStructBuildStrategy: StructBuildStrategy = {
  align,
  hasDynamicSize,

  validateFields: (fields: Omit<GpuStructField<unknown>, 'offset'>[]): void => {
    fields.forEach((field, i) => {
      const isRuntimeArray = isRuntimeSizedArray(field);
      if (isRuntimeArray && i !== fields.length - 1) {
        throw new Error(
          `Runtime-sized array field "${field.name}" must be the last field of the struct`,
        );
      }

      if (isRuntimeSizedStruct(field.type)) {
        throw new Error(
          `Runtime-sized struct field "${field.name}" cannot be members of other structs`,
        );
      }
    });
  },

  getFieldSize: (field: Omit<GpuStructField<unknown>, 'offset'>): number => {
    switch (true) {
      case 'size' in field.type:
        return field.type.size;
      case 'stride' in field.type:
        return field.type.length !== undefined
          ? field.type.stride * field.type.length
          : 0; // runtime-sized : contribute 0 to static size
      default:
        throw new Error(`Unknown type for field ${field.name}`);
    }
  },

  getFieldAlignment: (
    field: Omit<GpuStructField<unknown>, 'offset'>,
  ): number => {
    switch (true) {
      case 'alignment' in field.type:
        return field.type.alignment;
      case 'element' in field.type:
        return field.type.element.alignment;
      default:
        throw new Error(`Unknown type for field ${field.name}`);
    }
  },

  getFieldOffset: ({
    offset,
    alignment,
  }: {
    offset: number;
    alignment: number;
  }): number => {
    return align(offset, alignment);
  },

  getRuntimeSizeCallback: <T = unknown>(
    blueprint: GpuStructFieldBluePrint,
  ): ((value: T) => number) => {
    const runtimeField = getRuntimeSizedArrayField(blueprint);

    return !runtimeField
      ? (_: T) => align(blueprint.size, blueprint.alignment)
      : (value: T) => {
          const runtimeFieldValue = value[runtimeField.name as keyof T];
          if (runtimeFieldValue === undefined) {
            throw new Error(
              `Missing value for runtime-sized field ${runtimeField.name}`,
            );
          }

          if (!Array.isArray(runtimeFieldValue)) {
            throw new Error(
              `Runtime-sized field ${runtimeField.name} must be an array`,
            );
          }

          const runtimeFieldSize =
            (runtimeField.type as GpuArray<unknown>).stride *
            runtimeFieldValue.length;
          const totalSize = align(
            runtimeField.offset + runtimeFieldSize,
            blueprint.alignment,
          );
          return totalSize;
        };
  },

  getWriteCallback: (blueprint: GpuStructFieldBluePrint) => {
    return (target: ArrayBuffer, offset: number, value: unknown): void => {
      for (const field of blueprint.fields) {
        const fieldValue = (value as any)[field.name];
        if (fieldValue === undefined) {
          throw new Error(`Missing value for field ${field.name}`);
        }
        field.type.write(target, offset + field.offset, fieldValue);
      }
    };
  },

  getSerializeCallback: (blueprint: GpuStructFieldBluePrint) => {
    return (): string => serializeStruct(blueprint);
  },
};

export const uniformStructBuildStrategy: StructBuildStrategy = {
  align,
  hasDynamicSize: (): true | undefined => undefined,

  validateFields: (fields: Omit<GpuStructField<unknown>, 'offset'>[]): void => {
    fields.forEach((field, i) => {
      const isRuntimeArray = isRuntimeSizedArray(field);
      if (isRuntimeArray) {
        throw new Error(
          `Runtime-sized array field "${field.name}" are not allowed in uniform structs`,
        );
      }

      if (isRuntimeSizedStruct(field.type)) {
        throw new Error(
          `Runtime-sized struct field "${field.name}" are not allowed in uniform structs`,
        );
      }

      // Unlike alignment, the stride cannot be fixed with an attribute: WGSL
      // derives it from the element type.
      if (isArray(field.type) && field.type.stride % 16 !== 0) {
        throw new Error(
          `Array field "${field.name}" has a stride of ${field.type.stride} bytes, but arrays in uniform structs need a stride multiple of 16 (use vec4 elements instead)`,
        );
      }
    });
  },

  getFieldSize: (field: Omit<GpuStructField<unknown>, 'offset'>): number =>
    uniformFieldSize(field.type),

  getFieldAlignment: (field: Omit<GpuStructField<unknown>, 'offset'>): number =>
    uniformFieldAlignment(field.type),

  getFieldOffset: ({
    offset,
    alignment,
  }: {
    offset: number;
    alignment: number;
  }): number => {
    return align(offset, alignment);
  },

  getRuntimeSizeCallback: <T = unknown>(
    blueprint: GpuStructFieldBluePrint,
  ): ((value: T) => number) => {
    return () => align(blueprint.size, blueprint.alignment);
  },

  getWriteCallback: (blueprint: GpuStructFieldBluePrint) => {
    return (target: ArrayBuffer, offset: number, value: unknown): void => {
      for (const field of blueprint.fields) {
        const fieldValue = (value as any)[field.name];
        if (fieldValue === undefined) {
          throw new Error(`Missing value for field ${field.name}`);
        }
        field.type.write(target, offset + field.offset, fieldValue);
      }
    };
  },

  getSerializeCallback: (blueprint: GpuStructFieldBluePrint) => {
    return (): string => serializeStruct(blueprint, uniformMemberAttributes);
  },
};

export const storageStruct = <T>(
  fields: Omit<GpuStructField<unknown>, 'offset'>[],
) => struct<T>(storageStructBuildStrategy, fields);

export const uniformStructBuilder = <T>(
  fields: Omit<GpuStructField<unknown>, 'offset'>[],
) => struct<T>(uniformStructBuildStrategy, fields);
