import { GpuType } from './GpuType';

export interface GpuArray<T> {
  readonly element: GpuType<T>;
  readonly stride: number;
  readonly length?: number;

  write(target: ArrayBuffer, offset: number, value: T[]): void;
}
