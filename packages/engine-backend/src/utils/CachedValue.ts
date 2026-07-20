import type { SnapshotProvider, CachedValueProps } from './types';

export class CachedValue<
  T,
  TDependencies extends readonly SnapshotProvider<any>[]
> implements SnapshotProvider<T>
{
  private _version: number;
  private _value: T;
  private _dependencies: TDependencies;
  private _dependencyVersions?: number[];
  private _updateStrategy: (oldValue: T, dependencies: TDependencies) => T;
  private _updating: boolean;

  constructor(props: CachedValueProps<T, TDependencies>) {
    this._version = 0;
    this._value = props.initialValue;
    this._dependencies = props.dependencies ?? ([] as unknown as TDependencies);
    this._updateStrategy = props.updateStrategy;
    this._updating = false;
  }

  get version() {
    this.ensureUpdated();
    return this._version;
  }

  get value() {
    this.ensureUpdated();
    return this._value;
  }

  set dependencies(dependencies: TDependencies) {
    this._dependencies = dependencies;
    this.invalidate(); // Mark as dirty when dependencies change
  }

  invalidate() {
    this._dependencyVersions = undefined; // Mark as dirty
  }

  private get dirty() {
    return (
      this._dependencyVersions === undefined ||
      this._dependencies.some(
        (dep, index) => dep.version !== this._dependencyVersions![index]
      )
    );
  }

  private ensureUpdated() {
    if (this._updating) {
      throw new Error(
        'Circular dependency detected while updating CachedValue.'
      );
    }

    if (this.dirty) {
      this._updating = true;
      this._value = this._updateStrategy(this._value, this._dependencies);
      this._version++;
      this._dependencyVersions = this._dependencies.map((dep) => dep.version);
      this._updating = false;
    }
  }
}

export default CachedValue;
