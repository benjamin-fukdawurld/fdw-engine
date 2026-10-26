import type {
  BottomLevelDescriptor,
  GpuBottomLevel,
  GpuTopLevel,
  TopLevelDescriptor,
  TopLevelInstance,
} from '@fdw/engine-backend';
import {
  BottomLevelFlags,
  type BottomLevelHandle,
  type ContextHandle,
  type TopLevelHandle,
  type VulkanAddon,
} from '../addon';

// The acceleration structures of the GPU (VK_KHR_acceleration_structure),
// traced against by the ray queries of the programs.

/** Words of an instance of updateTopLevel (fdw_vk_instance). */
const InstanceWords = 14;

export class VulkanBottomLevel implements GpuBottomLevel {
  readonly label?: string;
  readonly triangleCount: number;
  readonly id: number;
  readonly dynamic: boolean;
  private _destroyed = false;

  constructor(
    private readonly addon: VulkanAddon,
    readonly handle: BottomLevelHandle,
    { indices, label, dynamic = false }: BottomLevelDescriptor,
  ) {
    this.triangleCount = indices.length / 3;
    this.dynamic = dynamic;
    this.id = addon.bottomLevelId(handle);
    this.label = label;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  destroy(): void {
    if (!this._destroyed) {
      this._destroyed = true;
      this.addon.destroyBottomLevel(this.handle);
    }
  }
}

export class VulkanTopLevel implements GpuTopLevel {
  readonly label?: string;
  readonly id: number;
  private _instanceCount = 0;
  private _version = 0;
  private _data = new Uint32Array(0);

  constructor(
    private readonly addon: VulkanAddon,
    readonly handle: TopLevelHandle,
    { label }: TopLevelDescriptor = {},
  ) {
    this.label = label;
    this.id = addon.topLevelId(handle);
  }

  get instanceCount(): number {
    return this._instanceCount;
  }

  get version(): number {
    return this._version;
  }

  update(instances: readonly TopLevelInstance[]): void {
    const words = instances.length * InstanceWords;
    if (this._data.length < words) {
      this._data = new Uint32Array(Math.max(words, this._data.length * 2));
    }
    const data = this._data;
    const floats = new Float32Array(data.buffer);
    instances.forEach(({ bottom, transform, mask = 0xff, opaque }, i) => {
      if (!(bottom instanceof VulkanBottomLevel) || bottom.destroyed) {
        throw new Error(
          'A bottom level of the instances was not created by the Vulkan backend, or was destroyed',
        );
      }
      const at = i * InstanceWords;
      // The rows of the 3 × 4 matrix, from the column-major 4 × 4.
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 4; column++) {
          floats[at + row * 4 + column] = transform[column * 4 + row];
        }
      }
      data[at + 12] = bottom.id;
      // Bit 8: not opaque (see fdw_vk_instance).
      data[at + 13] = (mask & 0xff) | (opaque === false ? 0x100 : 0);
    });
    if (this.addon.updateTopLevel(this.handle, data.subarray(0, words))) {
      this._version++;
    }
    this._instanceCount = instances.length;
  }

  destroy(): void {
    this.addon.destroyTopLevel(this.handle);
  }
}

export function createBottomLevel(
  addon: VulkanAddon,
  context: ContextHandle,
  descriptor: BottomLevelDescriptor,
): VulkanBottomLevel {
  return new VulkanBottomLevel(
    addon,
    addon.createBottomLevel(
      context,
      descriptor.positions,
      descriptor.indices,
      descriptor.dynamic ? BottomLevelFlags.dynamic : 0,
      descriptor.label,
    ),
    descriptor,
  );
}

export function createTopLevel(
  addon: VulkanAddon,
  context: ContextHandle,
  descriptor: TopLevelDescriptor = {},
): VulkanTopLevel {
  return new VulkanTopLevel(
    addon,
    addon.createTopLevel(context, descriptor.capacity ?? 64, descriptor.label),
    descriptor,
  );
}
