import { GpuArray } from './GpuArray';
import { GpuType } from './GpuType';

export interface GpuStructField<T> {
  readonly name: string;
  readonly type: GpuType<T> | GpuArray<T> | GpuStruct<T>;
  readonly offset: number;
}

export interface GpuStructFieldBluePrint {
  size: number;
  stride: number;
  alignment: number;
  fields: GpuStructField<unknown>[];
  hasDynamicSize?: true;
}

export interface GpuStruct<T = unknown>
  extends GpuType<T>, Readonly<GpuStructFieldBluePrint> {
  runtimeSize(value: T): number;
}

export interface StructBuildStrategy {
  align(offset: number, alignment: number): number;
  hasDynamicSize(blueprint: GpuStructFieldBluePrint): true | undefined;
  validateFields(fields: Omit<GpuStructField<unknown>, 'offset'>[]): void;
  getFieldSize(field: Omit<GpuStructField<unknown>, 'offset'>): number;
  getFieldAlignment(field: Omit<GpuStructField<unknown>, 'offset'>): number;
  getFieldOffset({
    offset,
    alignment,
  }: {
    offset: number;
    alignment: number;
  }): number;
  getRuntimeSizeCallback<T = unknown>(
    blueprint: GpuStructFieldBluePrint,
  ): (value: T) => number;
  getWriteCallback(
    blueprint: GpuStructFieldBluePrint,
  ): (target: ArrayBuffer, offset: number, value: unknown) => void;
  getSerializeCallback(blueprint: GpuStructFieldBluePrint): () => string;
}
