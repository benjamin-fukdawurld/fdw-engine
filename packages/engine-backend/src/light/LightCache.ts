import { GpuStruct } from '../gpu';
import { CachedValue, SnapshotProvider } from '../utils';
import { LightSnapshot } from './types';

class LightCache {
  public light: LightSnapshot;

  public readonly lightStructure: CachedValue<
    GpuStruct,
    [SnapshotProvider<LightSnapshot>]
  >;
}
