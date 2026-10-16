import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuRenderTarget } from '@fdw/engine-webgpu';
import type { NativeWindow } from './NativeWindow';

// A buffer receiving the copy of a frame, until it is shown.
interface Slot {
  buffer: GPUBuffer;
  width: number;
  height: number;
  // Bytes per row: aligned to 256 bytes, as copies require.
  stride: number;
  // Resolves when the frame is shown (or dropped).
  pending?: Promise<void>;
}

export interface DawnWindowSurfaceOptions {
  // Frames copied but not shown yet, at most: more means more latency.
  // Default 2.
  readonly framesInFlight?: number;
}

/**
 * A surface showing WebGPU (Dawn, the `webgpu` package in Node) frames in a
 * native window. Dawn in Node cannot present to a window: each frame is
 * rendered into a texture, copied into a buffer, read back, then shown by
 * the window. A frame or two of latency, and a copy of the image per frame:
 * for development, tools and tests, not for a final application (see
 * design/native-backends.md).
 */
export class DawnWindowSurface implements Surface {
  readonly format: GpuTextureFormat = 'rgba8unorm';
  private _device?: GPUDevice;
  private _target?: WebGpuRenderTarget;
  private readonly _slots: Slot[] = [];
  private readonly _framesInFlight: number;
  // Frames copied, and the last frame shown: an older frame read back after
  // a newer one is dropped.
  private _frame = 0;
  private _shown = 0;

  constructor(
    readonly window: NativeWindow,
    { framesInFlight = 2 }: DawnWindowSurfaceOptions = {},
  ) {
    this._framesInFlight = framesInFlight;
  }

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof WebGpuEngine) || !engine.device) {
      throw new Error('The surface needs a ready WebGpuEngine');
    }
    this._device = engine.device;
  }

  // The size of the window, in pixels.
  get width(): number {
    return this.window.width;
  }

  get height(): number {
    return this.window.height;
  }

  getCurrentTarget(): WebGpuRenderTarget {
    const device = this.device;
    const { width, height } = this;
    if (
      !this._target ||
      this._target.width !== width ||
      this._target.height !== height
    ) {
      this._target?.destroy();
      const texture = device.createTexture({
        label: 'window surface',
        size: [width, height],
        format: this.format as GPUTextureFormat,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST,
      });
      this._target = new WebGpuRenderTarget(
        texture.createView(),
        width,
        height,
        this.format,
        texture,
      );
    }
    return this._target;
  }

  /**
   * Copies the frame and shows it once read back. Dropped when every buffer
   * is busy: call throttle() between frames to avoid it.
   */
  present(): void {
    const texture = this._target?.texture;
    if (!texture || this.window.destroyed) {
      return;
    }
    const { width, height } = this._target as WebGpuRenderTarget;
    const slot = this.freeSlot(width, height);
    if (!slot) {
      return;
    }
    const encoder = this.device.createCommandEncoder({ label: 'present' });
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: slot.buffer, bytesPerRow: slot.stride },
      [width, height],
    );
    this.device.queue.submit([encoder.finish()]);

    const frame = ++this._frame;
    slot.pending = slot.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (frame > this._shown && !this.window.destroyed) {
          this._shown = frame;
          this.window.presentRgba(
            new Uint8Array(slot.buffer.getMappedRange()),
            slot.width,
            slot.height,
            slot.stride,
          );
        }
        slot.buffer.unmap();
      })
      .catch((error: unknown) => {
        // The mapping is aborted when the buffer or the device is destroyed
        // meanwhile (the window closes): the frame is dropped.
        if ((error as { name?: string })?.name !== 'AbortError') {
          throw error;
        }
      })
      .finally(() => {
        slot.pending = undefined;
      });
  }

  /**
   * Resolves when fewer frames than `framesInFlight` wait to be shown: the
   * throttle of runLoop, which then follows the pace of the window (its
   * vertical synchronization).
   */
  async throttle(): Promise<void> {
    for (;;) {
      const pending = this._slots
        .map((slot) => slot.pending)
        .filter((promise): promise is Promise<void> => promise !== undefined);
      if (pending.length < this._framesInFlight) {
        return;
      }
      await Promise.race(pending);
    }
  }

  destroy(): void {
    this._target?.destroy();
    this._target = undefined;
    for (const slot of this._slots) {
      // A buffer being mapped is destroyed once its mapping settles.
      if (slot.pending) {
        void slot.pending.then(() => slot.buffer.destroy());
      } else {
        slot.buffer.destroy();
      }
    }
    this._slots.length = 0;
    this._device = undefined;
  }

  private get device(): GPUDevice {
    if (!this._device) {
      throw new Error('The surface is not initialized');
    }
    return this._device;
  }

  // A buffer not waiting to be shown, of the size of the frame; one more
  // while there are fewer than framesInFlight + 1.
  private freeSlot(width: number, height: number): Slot | undefined {
    const stride = Math.ceil((width * 4) / 256) * 256;
    let slot = this._slots.find((candidate) => !candidate.pending);
    if (!slot) {
      if (this._slots.length > this._framesInFlight) {
        return undefined;
      }
      slot = { buffer: undefined as never, width: 0, height: 0, stride: 0 };
      this._slots.push(slot);
    }
    if (slot.width !== width || slot.height !== height) {
      // Created on first use, and when the window is resized.
      if (slot.buffer) {
        slot.buffer.destroy();
      }
      slot.buffer = this.device.createBuffer({
        label: 'window surface readback',
        size: stride * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      slot.width = width;
      slot.height = height;
      slot.stride = stride;
    }
    return slot;
  }
}
