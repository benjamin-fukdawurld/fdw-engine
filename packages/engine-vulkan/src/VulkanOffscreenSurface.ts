import type { Engine, GpuTextureFormat, Surface } from '@fdw/engine-backend';
import { VulkanTexture } from './gpu/VulkanTexture';
import { VulkanEngine } from './VulkanEngine';

// A surface rendering into a texture: for render-to-texture, screenshots and
// headless tests.
export class VulkanOffscreenSurface implements Surface {
  readonly format: GpuTextureFormat;
  private _width: number;
  private _height: number;
  private _engine?: VulkanEngine;
  private _target?: VulkanTexture;

  constructor(
    width: number,
    height: number,
    format: GpuTextureFormat = 'rgba8unorm'
  ) {
    this._width = width;
    this._height = height;
    this.format = format;
  }

  async init(engine: Engine): Promise<void> {
    if (!(engine instanceof VulkanEngine) || !engine.backend) {
      throw new Error('The surface needs a ready VulkanEngine');
    }
    this._engine = engine;
  }

  get width(): number {
    return this._width;
  }

  set width(value: number) {
    this._width = value;
    this.release();
  }

  get height(): number {
    return this._height;
  }

  set height(value: number) {
    this._height = value;
    this.release();
  }

  getCurrentTarget(): VulkanTexture {
    const backend = this._engine?.backend;
    if (!backend) {
      throw new Error('The surface is not initialized');
    }
    this._target ??= backend.createRenderTarget({
      width: this._width,
      height: this._height,
      format: this.format,
      label: 'offscreen surface',
    });
    return this._target;
  }

  present(): void {
    return;
  }

  // Reads back the pixels of the last frame, row by row from the top,
  // without padding.
  async readPixels(): Promise<Uint8Array> {
    if (!this._target) {
      throw new Error('Nothing has been rendered to the surface');
    }
    return new Uint8Array(await this._target.read());
  }

  destroy(): void {
    this.release();
    this._engine = undefined;
  }

  private release(): void {
    this._target?.destroy();
    this._target = undefined;
  }
}
