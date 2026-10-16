import { describe, expect, it, vi } from 'vitest';
import { CachedValue } from './CachedValue';
import { SnapshotValue } from './SnapshotValue';

describe('CachedValue', () => {
  it('computes lazily and only when a dependency version changes', () => {
    let version = 0;
    const update = vi.fn(
      (_: number, [source]: [SnapshotValue<number>]) => source.value * 2,
    );
    const source = new SnapshotValue({
      valueGetter: () => version + 1,
      versionGetter: () => version,
    });
    const cached = new CachedValue({
      initialValue: 0,
      dependencies: [source] as [SnapshotValue<number>],
      updateStrategy: update,
    });

    expect(update).not.toHaveBeenCalled();
    expect(cached.value).toBe(2);
    expect(cached.value).toBe(2);
    expect(update).toHaveBeenCalledTimes(1);

    version = 1;
    expect(cached.value).toBe(4);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('retries the update after an exception instead of reporting a circular dependency', () => {
    let fail = true;
    const cached = new CachedValue<number, []>({
      initialValue: 0,
      updateStrategy: () => {
        if (fail) {
          throw new Error('device lost');
        }
        return 42;
      },
    });

    expect(() => cached.value).toThrow('device lost');
    fail = false;
    expect(cached.value).toBe(42);
    expect(cached.version).toBe(1);
  });

  it('detects circular dependencies', () => {
    const holder: { cached?: CachedValue<number, [CachedValue<number, []>]> } =
      {};
    const self = new CachedValue<number, []>({
      initialValue: 0,
      updateStrategy: () => holder.cached!.value,
    });
    holder.cached = new CachedValue({
      initialValue: 0,
      dependencies: [self],
      updateStrategy: () => 1,
    });
    expect(() => holder.cached!.value).toThrow(/Circular dependency/);
  });
});
