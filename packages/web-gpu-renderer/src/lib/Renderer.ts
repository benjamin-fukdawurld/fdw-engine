export class Renderer {
  canvas: HTMLCanvasElement;
  private _adapter: GPUAdapter | null;
  private _device: GPUDevice | null;
  private _context: GPUCanvasContext | null;
  private _presentationFormat: GPUTextureFormat | null;
  private _depthTexture: GPUTexture | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this._adapter = null;
    this._device = null;
    this._context = null;
    this._presentationFormat = null;
    this._depthTexture = null;
  }

  public get adapter(): GPUAdapter {
    if (!this._adapter) {
      throw new Error('Renderer has not been initialized.');
    }

    return this._adapter;
  }

  public get device(): GPUDevice {
    if (!this._device) {
      throw new Error('Renderer has not been initialized.');
    }

    return this._device;
  }

  public get context(): GPUCanvasContext {
    if (!this._context) {
      throw new Error('Renderer has not been initialized.');
    }

    return this._context;
  }

  public get presentationFormat(): GPUTextureFormat {
    if (!this._presentationFormat) {
      throw new Error('Renderer has not been initialized.');
    }

    return this._presentationFormat;
  }

  public get depthTexture(): GPUTexture {
    const canvasTexture = this.context.getCurrentTexture();
    if (
      !this._depthTexture ||
      this._depthTexture.width != canvasTexture.width ||
      this._depthTexture.height != canvasTexture.height
    ) {
      if (this._depthTexture) {
        this._depthTexture.destroy();
      }

      this._depthTexture = this.device.createTexture({
        size: [canvasTexture.width, canvasTexture.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    return this._depthTexture;
  }

  public clearCanvas(): GPUCommandEncoder {
    const canvasTexture = this.context.getCurrentTexture();
    const renderPassDescriptor = {
      label: 'Clear Pass',
      colorAttachments: [
        {
          view: canvasTexture.createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as GPURenderPassDescriptor;

    const encoder = this._device!.createCommandEncoder({
      label: 'encoder',
    });
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.end();
    return encoder;
  }

  async init() {
    if (navigator.gpu === undefined) {
      throw new Error('WebGPU is not supported on this page');
    }

    this._adapter = await navigator.gpu.requestAdapter();
    if (!this._adapter) {
      throw new Error(
        'Unable to get GPU Adapter from navigator (WebGPU might not be supported)'
      );
    }

    this._device = await this._adapter.requestDevice({
      label: 'WebGPU Device',
    });
    if (!this._device) {
      throw new Error(
        'Unable to get GPU Device from Adapter (WebGPU might not be supported)'
      );
    }

    this._device.addEventListener('uncapturederror', (event: any) => {
      console.error(event.error.message);
    });

    this._context = this.canvas.getContext('webgpu');
    if (!this._context) {
      throw new Error(
        'Cannot get WebGPU context from HTMLCanvasElement (WebGPU might not be supported)'
      );
    }

    this._presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this._context.configure({
      device: this._device,
      format: this._presentationFormat,
    });
  }
}

export default Renderer;
