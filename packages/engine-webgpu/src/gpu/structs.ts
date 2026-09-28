import {
  GpuArray,
  GpuStructField,
  GpuStructFieldBluePrint,
  struct,
  StructBuildStrategy,
} from '@fdw/engine-backend';

const align = (offset: number, alignment: number): number =>
  Math.ceil(offset / alignment) * alignment;

const isRuntimeSizedArray = (
  field: Omit<GpuStructField<unknown>, 'offset'>
): boolean => 'element' in field.type && field.type.length === undefined;

const getRuntimeSizedArrayField = (
  blueprint: GpuStructFieldBluePrint
): GpuStructField<unknown> | undefined => {
  const lastField = blueprint.fields[blueprint.fields.length - 1];
  return lastField && isRuntimeSizedArray(lastField) ? lastField : undefined;
};

const hasDynamicSize = (
  blueprint: GpuStructFieldBluePrint
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
          `Runtime-sized array field "${field.name}" must be the last field of the struct`
        );
      }

      const isRuntimeStruct = 'hasDynamicSize' in field.type;
      if (isRuntimeStruct) {
        throw new Error(
          `Runtime-sized struct field "${field.name}" cannot be members of other structs`
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
    field: Omit<GpuStructField<unknown>, 'offset'>
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
    blueprint: GpuStructFieldBluePrint
  ): ((value: T) => number) => {
    const runtimeField = getRuntimeSizedArrayField(blueprint);

    return !runtimeField
      ? (_: T) => blueprint.size
      : (value: T) => {
          const runtimeFieldValue = value[runtimeField.name as keyof T];
          if (runtimeFieldValue === undefined) {
            throw new Error(
              `Missing value for runtime-sized field ${runtimeField.name}`
            );
          }

          if (!Array.isArray(runtimeFieldValue)) {
            throw new Error(
              `Runtime-sized field ${runtimeField.name} must be an array`
            );
          }

          const runtimeFieldSize =
            (runtimeField.type as GpuArray<unknown>).stride *
            runtimeFieldValue.length;
          const totalSize = align(
            runtimeField.offset + runtimeFieldSize,
            blueprint.alignment
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
    return (): string => {
      const fields = blueprint.fields
        .map((field) => {
          return `${field.name}: ${field.type.serialize()}`;
        })
        .join(',\n  ');
      return `{
  ${fields}
}`;
    };
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
          `Runtime-sized array field "${field.name}" are not allowed in uniform structs`
        );
      }

      const isRuntimeStruct = 'hasDynamicSize' in field.type;
      if (isRuntimeStruct) {
        throw new Error(
          `Runtime-sized struct field "${field.name}" are not allowed in uniform structs`
        );
      }
    });
  },

  getFieldSize: (field: Omit<GpuStructField<unknown>, 'offset'>): number => {
    switch (true) {
      case 'size' in field.type:
        return field.type.size;
      case 'stride' in field.type:
        return field.type.stride * (field.type.length ?? 1);
      default:
        throw new Error(`Unknown type for field ${field.name}`);
    }
  },

  getFieldAlignment: (
    field: Omit<GpuStructField<unknown>, 'offset'>
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
    blueprint: GpuStructFieldBluePrint
  ): ((value: T) => number) => {
    return () => blueprint.size;
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
    return (): string => {
      const fields = blueprint.fields
        .map((field) => {
          return `${field.name}: ${field.type.serialize()}`;
        })
        .join(',\n  ');
      return `{
  ${fields}
}`;
    };
  },
};

export const storageStruct = <T>(
  fields: Omit<GpuStructField<unknown>, 'offset'>[]
) => struct<T>(storageStructBuildStrategy, fields);

export const uniformStructBuilder = <T>(
  fields: Omit<GpuStructField<unknown>, 'offset'>[]
) => struct<T>(uniformStructBuildStrategy, fields);
