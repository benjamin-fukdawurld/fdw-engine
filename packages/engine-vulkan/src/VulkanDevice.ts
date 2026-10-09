import { ContextHandle, loadVulkanAddon, VulkanAddon } from './addon';
import { VulkanBufferFactory } from './gpu/VulkanBuffer';

export interface VulkanDeviceOptions {
  // Enables the Khronos validation layer when it is installed (the Vulkan
  // SDK). Its messages are read with takeMessages().
  readonly validation?: boolean;
  readonly application?: string;
}

/**
 * A Vulkan device: the context of the native library (instance, GPU,
 * queue, memory), and the factories of its resources. The engine and the
 * render backend are built on it.
 */
export class VulkanDevice {
  readonly name: string;
  readonly validation: boolean;
  readonly buffers: VulkanBufferFactory;
  private readonly _addon: VulkanAddon;
  private _context?: ContextHandle;

  constructor({ validation = false, application }: VulkanDeviceOptions = {}) {
    this._addon = loadVulkanAddon();
    this._context = this._addon.createContext(validation, application);
    this.name = this._addon.deviceName(this._context);
    this.validation = this._addon.validationEnabled(this._context);
    this.buffers = new VulkanBufferFactory(this._addon, this._context);
  }

  /** The addon handle, for the other objects of the backend. */
  get context(): ContextHandle {
    if (!this._context) {
      throw new Error('The Vulkan device was destroyed');
    }
    return this._context;
  }

  /** The warnings and errors of the validation layer since the last call. */
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
