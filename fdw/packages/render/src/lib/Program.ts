import Gpu from './Gpu';

/**
 * Object containing the necessary data to initialize a Program.
 */
export type ProgramDescriptor = {
  /**
   * Generate a GPUShaderModuleDescriptor for the current program.
   * @returns The GPUShaderModuleDescriptor of the Program.
   */
  shaderDescriptor: () => GPUShaderModuleDescriptor;

  /**
   * Generate a GPURenderPipelineDescriptor for the Program.
   * @param shader The GPUShaderModule of the program.
   * @returns The GPURenderPipelineDescriptor of the Program.
   */
  pipelineDescriptor: (shader: GPUShaderModule) => GPURenderPipelineDescriptor;
};

/**
 * Class representing a WebGPU shader program.
 *
 * It contains both, the shader module and the render pipeline of the program.
 */
export class Program {
  private _shaderModule: GPUShaderModule | null;
  private _pipeline: GPURenderPipeline | null;

  constructor() {
    this._shaderModule = null;
    this._pipeline = null;
  }

  /**
   * Check whether or not the Program is initialized (ie: shader module and
   * pipeline have been created).
   * @date 10/09/2023 - 13:54:05
   *
   * @public
   * @readonly
   * @type {boolean}
   */
  public get ready(): boolean {
    return !!this._shaderModule && !!this._pipeline;
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
   * Initialize the Program by creating the shader module and setting up the
   * pipeline
   *
   * @param gpu the Gpu wrapper
   * @param programDescriptor The Program descriptor
   */
  async init(
    gpu: Gpu,
    { shaderDescriptor, pipelineDescriptor }: ProgramDescriptor
  ): Promise<void> {
    this._shaderModule = gpu.device.createShaderModule(shaderDescriptor());
    this._pipeline = gpu.device.createRenderPipeline(
      pipelineDescriptor(this._shaderModule)
    );
  }
}

export default Program;
