import { ContextHandle, VulkanBufferFactory } from '@fdw/engine-vulkan';
import { D3D12Addon, loadD3D12Addon } from './addon';

export interface D3D12DeviceOptions {
  // Enables the debug layer when it is installed (the Graphics Tools of
  // Windows). Its messages are read with takeMessages().
  readonly validation?: boolean;
  readonly application?: string;
}

/**
 * A Direct3D 12 device: the context of the native library (device, queue,
 * descriptor heaps), and the factories of its resources. The engine and
 * the render backend are built on it.
 */
export class D3D12Device {
  readonly name: string;
  readonly validation: boolean;
  readonly buffers: VulkanBufferFactory;
  private readonly _addon: D3D12Addon;
  private _context?: ContextHandle;

  constructor({ validation = false, application }: D3D12DeviceOptions = {}) {
    this._addon = loadD3D12Addon();
    this._context = this._addon.createContext(validation, application);
    this.name = this._addon.deviceName(this._context);
    this.validation = this._addon.validationEnabled(this._context);
    // The buffers of the Vulkan backend: the addons have the same API.
    this.buffers = new VulkanBufferFactory(this._addon, this._context);
  }

  /** The addon handle, for the other objects of the backend. */
  get context(): ContextHandle {
    if (!this._context) {
      throw new Error('The Direct3D 12 device was destroyed');
    }
    return this._context;
  }

  /** The warnings and errors of the debug layer since the last call. */
  takeMessages(): string[] {
    return this._addon.takeMessages(this.context);
  }

  /** Waits until the GPU has run every submitted command. */
  waitIdle(): void {
    this._addon.waitIdle(this.context);
  }

  /** Destroys the device and every resource left. */
  destroy(): void {
    if (this._context) {
      this._addon.destroyContext(this._context);
      this._context = undefined;
    }
  }
}
