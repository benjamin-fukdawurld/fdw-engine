import Gpu from './Gpu';

export type SurfaceResizeContext = {
  surface: Surface;
  gpu: Gpu;
};

export type SurfaceResizeFunc = (ctx: SurfaceResizeContext) => void;

/**
 * Class representing a canvas with the WebGPU context that belongs to it.
 */
export class Surface {
  /**
   * The canvas that own the context.
   * @date 09/09/2023 - 17:18:59
   *
   * @public
   * @readonly
   * @type {HTMLCanvasElement}
   */
  public readonly canvas: HTMLCanvasElement;

  public onResize?: SurfaceResizeFunc;

  private _resizeObserver: ResizeObserver | null;

  /**
   * The WebGPU context attached to the canvas.
   * @date 09/09/2023 - 17:19:18
   *
   * @private
   * @type {(GPUCanvasContext | null)}
   */
  private _context: GPUCanvasContext | null;

  /**
   * The preferred format for the WebGPU context.
   * @date 09/09/2023 - 17:20:23
   *
   * @private
   * @type {(GPUTextureFormat | null)}
   */
  private _format: GPUTextureFormat | null;

  /**
   * Create a Surface object, set the canvas and initialize the WebGPU context
   * and the preferred format to null.
   * @param canvas the canvas this context is attached to.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this._resizeObserver = null;
    this._context = null;
    this._format = null;
  }

  /**
   * Check whether the Surface has been initialized (ie: the WebGPU context and
   * the prefered format has been set and configured).
   * @date 09/09/2023 - 17:22:41
   *
   * @readonly
   * @type {boolean}
   */
  get ready(): boolean {
    return !!this._context && !!this._format;
  }

  /**
   * Get the WebGPU context. If the WebGPU context has not been initialized it
   * throws an error.
   * @date 09/09/2023 - 17:23:32
   *
   * @readonly
   * @type {GPUCanvasContext}
   */
  get context(): GPUCanvasContext {
    if (!this._context) {
      throw new Error('Surface is not initialized');
    }

    return this._context;
  }

  /**
   * Get the WebGPU context's preferred format. If the preferred format has not
   * been initialized it throws an error.
   * @date 09/09/2023 - 17:26:38
   *
   * @readonly
   * @type {GPUTextureFormat}
   */
  get format(): GPUTextureFormat {
    if (!this._format) {
      throw new Error('Surface is not initialized');
    }

    return this._format;
  }

  /**
   * Initialize the Gpu asynchronously. If the browser does not support WebGPU
   * or if the GPU adapter or device cannot be acquired the function throws an
   * error.
   *
   * @param gpu The Gpu object that holds the WebGPU adapter and device.
   */
  async init(gpu: Gpu): Promise<void> {
    this.canvas.width = this.canvas.offsetWidth;
    this.canvas.height = this.canvas.offsetHeight;

    this._context = this.canvas.getContext('webgpu') ?? null;
    if (!this._context) {
      throw new Error('canvas does not support WebGPU');
    }

    this._format = navigator.gpu.getPreferredCanvasFormat();
    this._context.configure({
      device: gpu.device,
      format: this._format,
    });

    this._resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const width = Math.min(
          entry.contentBoxSize[0].inlineSize,
          gpu.device.limits.maxTextureDimension2D
        );
        const height = Math.min(
          entry.contentBoxSize[0].blockSize,
          gpu.device.limits.maxTextureDimension2D
        );

        this.canvas.width = Math.max(1, width);
        this.canvas.height = Math.max(1, height);

        if (this.onResize) {
          this.onResize({ surface: this, gpu });
        }
      });
    });

    this._resizeObserver.observe(this.canvas);
  }
}

export default Surface;
