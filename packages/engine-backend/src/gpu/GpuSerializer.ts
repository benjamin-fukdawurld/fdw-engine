export interface GpuSerializer {
  serialize(): string;
  serializeArray(length?: number): string;
}
