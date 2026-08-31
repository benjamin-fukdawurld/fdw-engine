import {
  GpuStruct,
  GpuStructField,
  GpuStructFieldBluePrint,
  StructBuildStrategy,
} from './GpuStruct';

export class StructBuilder {
  readonly strategy: StructBuildStrategy;
  private blueprint: GpuStructFieldBluePrint;

  constructor(strategy: StructBuildStrategy) {
    this.strategy = strategy;
    this.blueprint = {
      size: 0,
      stride: 0,
      alignment: 1,
      fields: [],
    };
  }

  withField<T>(field: Omit<GpuStructField<T>, 'offset'>): this {
    this.strategy.validateFields([...this.blueprint.fields, field]);
    const fieldSize = this.strategy.getFieldSize(field);
    const fieldAlignment = this.strategy.getFieldAlignment(field);
    const fieldOffset = this.strategy.getFieldOffset({
      offset: this.blueprint.stride,
      alignment: fieldAlignment,
    });
    this.blueprint.fields.push({
      ...field,
      offset: fieldOffset,
    });
    this.blueprint.alignment = Math.max(
      this.blueprint.alignment,
      fieldAlignment
    );
    this.blueprint.stride = fieldOffset + fieldSize;
    this.blueprint.size = this.blueprint.stride;
    return this;
  }

  withFields(fields: Omit<GpuStructField<unknown>, 'offset'>[]): this {
    fields.forEach((field) => this.withField(field));
    return this;
  }

  build<T>(): GpuStruct<T> {
    this.strategy.validateFields(this.blueprint.fields);

    const { size, stride, alignment, fields } = this.blueprint;
    const alignedStride = this.strategy.align(stride, alignment);
    return {
      size,
      alignment,
      fields,
      stride: alignedStride,
      hasDynamicSize: this.strategy.hasDynamicSize(this.blueprint),
      runtimeSize: this.strategy.getRuntimeSizeCallback(this.blueprint),
      write: this.strategy.getWriteCallback(this.blueprint),
      serialize: this.strategy.getSerializeCallback(this.blueprint),
    };
  }

  clear(): this {
    this.blueprint = {
      size: 0,
      stride: 0,
      alignment: 1,
      fields: [],
    };
    return this;
  }
}

export function struct<T>(
  strategy: StructBuildStrategy,
  fields: Omit<GpuStructField<unknown>, 'offset'>[]
): GpuStruct<T> {
  return new StructBuilder(strategy).withFields(fields).build<T>();
}
