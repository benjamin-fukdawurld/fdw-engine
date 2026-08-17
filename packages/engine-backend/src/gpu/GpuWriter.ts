export interface GpuWriter<T> {
  write(target: ArrayBuffer, offset: number, value: T): void;
}
