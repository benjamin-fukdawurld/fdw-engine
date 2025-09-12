export interface IRenderer {
  canvas: HTMLCanvasElement;
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  presentationFormat: GPUTextureFormat;
  depthTexture: GPUTexture;
}

export type RenderContext = IRenderer & {
  pass: GPURenderPassEncoder;
};
