import { SnapshotProvider } from './types';

export class SnapshotValue<T> implements SnapshotProvider<T> {
  private readonly _valueGetter: () => T;
  private readonly _versionGetter: () => number;

  constructor(props: { valueGetter: () => T; versionGetter: () => number }) {
    this._valueGetter = props.valueGetter;
    this._versionGetter = props.versionGetter;
  }

  get value(): T {
    return this._valueGetter();
  }

  get version(): number {
    return this._versionGetter();
  }
}

export default SnapshotValue;
