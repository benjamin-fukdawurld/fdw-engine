export type SnapshotProvider<T> = {
  readonly version: number;
  readonly value: T;
};

export type CachedValueProps<
  T,
  TDependencies extends readonly SnapshotProvider<any>[],
> = {
  initialValue: T;
  dependencies?: TDependencies;
  updateStrategy(oldValue: T, dependencies: TDependencies): T;
};
