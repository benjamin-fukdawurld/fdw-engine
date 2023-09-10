import Gpu from './Gpu';

export type ProgramDescriptor = {
  shaderDescriptor: () => GPUShaderModuleDescriptor;
  pipelineDescriptor: (shader: GPUShaderModule) => GPURenderPipelineDescriptor;
  encoderDescriptor: () => GPUCommandEncoderDescriptor;
};

export default class Program {
  private _shaderModule: GPUShaderModule | null;
  private _pipeline: GPURenderPipeline | null;
  private _encoder: GPUCommandEncoder | null;

  constructor() {
    this._shaderModule = null;
    this._pipeline = null;
    this._encoder = null;
  }

  /**
   * Check whether or not the Program is initialized (ie: shader module and
   * device have been requested).
   * @date 10/09/2023 - 13:54:05
   *
   * @public
   * @readonly
   * @type {boolean}
   */
  public get ready(): boolean {
    return !!this._shaderModule && !!this._pipeline && !!this._encoder;
  }

  /**
   * Get the shader module. If the Program has not been initialized it
   * throws an error.
   * @date 10/09/2023 - 13:54:37
   *
   * @public
   * @readonly
   * @type {GPUShaderModule}
   */
  public get shaderModule(): GPUShaderModule {
    if (!this._shaderModule) {
      throw new Error('Program is not initialized');
    }

    return this._shaderModule;
  }

  /**
   * Get the render pipeline. If the Program has not been initialized it
   * throws an error.
   * @date 10/09/2023 - 13:56:29
   *
   * @public
   * @readonly
   * @type {GPURenderPipeline}
   */
  public get pipeline(): GPURenderPipeline {
    if (!this._pipeline) {
      throw new Error('Program is not initialized');
    }

    return this._pipeline;
  }

  /**
   * Get the command encoder. If the Program has not been initialized it
   * throws an error.
   * @date 10/09/2023 - 13:57:02
   *
   * @public
   * @readonly
   * @type {GPUCommandEncoder}
   */
  public get encoder(): GPUCommandEncoder {
    if (!this._encoder) {
      throw new Error('Program is not initialized');
    }

    return this._encoder;
  }

  async init(
    gpu: Gpu,
    {
      shaderDescriptor,
      pipelineDescriptor,
      encoderDescriptor,
    }: ProgramDescriptor
  ): Promise<void> {
    this._shaderModule = gpu.createShaderModule(shaderDescriptor());
    this._pipeline = gpu.createRenderPipeline(
      pipelineDescriptor(this._shaderModule)
    );
    this._encoder = gpu.createCommandEncoder(encoderDescriptor());
  }
}
