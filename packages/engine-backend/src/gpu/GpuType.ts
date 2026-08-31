export interface GpuType<T> {
  readonly size: number;
  readonly alignment: number;

  write(target: ArrayBuffer, offset: number, value: T): void;
  serialize(): string;
}
