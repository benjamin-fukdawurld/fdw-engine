import {
  GpuArray,
  GpuSampler,
  GpuStruct,
  GpuTexture,
  GpuTextureFormat,
  GpuTextureType,
  GpuType,
} from '../gpu';
import { CachedValue, SnapshotProvider } from '../utils';

export const MaterialBindingSlotNames = [
  'frame',
  'material',
  'object',
] as const;
export type MaterialBindingSlotName = (typeof MaterialBindingSlotNames)[number];
export type MaterialBindingSlot = MaterialBindingSlotName | (string & {});

export type MaterialUniformType<T = unknown> =
  GpuType<T> | GpuStruct<T> | GpuArray<T>;

export type MaterialUniformBindingShape<T = unknown> = {
  kind: 'uniform' | 'storage';
  name: string;
  slot: MaterialBindingSlot;
  type: MaterialUniformType<T>;
};

export type MaterialTextureBindingShape = {
  kind: 'texture';
  name: string;
  slot: MaterialBindingSlot;
  type: GpuTextureType;
  format: GpuTextureFormat;
};

export type MaterialBindingShape =
  MaterialUniformBindingShape | MaterialTextureBindingShape;

export type MaterialUniformBinding<
  T = unknown,
  TDependencies extends readonly SnapshotProvider<unknown>[] =
    SnapshotProvider<unknown>[],
> = MaterialUniformBindingShape<T> & {
  value: CachedValue<T, TDependencies>;
};

export type MaterialTextureBinding<
  TDependencies extends readonly SnapshotProvider<unknown>[] =
    SnapshotProvider<unknown>[],
> = MaterialTextureBindingShape & {
  texture: CachedValue<GpuTexture, TDependencies>;
  sampler?: GpuSampler;
};

export type MaterialBinding = MaterialUniformBinding | MaterialTextureBinding;

export interface MaterialDescription {
  readonly label?: string;
  readonly shadingModel: string;
  readonly shape: Readonly<MaterialBindingShape[]>;
}
