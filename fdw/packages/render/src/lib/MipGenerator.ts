import Gpu from './Gpu';
import Program from './Program';

// eslint-disable-next-line
// @ts-ignore
import shaderCode from './assets/mipmap.wgsl?raw';

export class MipGenerator {
  private _sampler: GPUSampler | null;

  private _programMap: Map<GPUTextureFormat, Program>;

  public constructor() {
    this._programMap = new Map<GPUTextureFormat, Program>();
    this._sampler = null;
  }

  /**
   * Get the generator's sampler. If the MipGenerator has not been initialized
   * it throws an error.
   *
   * @public
   * @readonly
   * @type {GPUSampler}
   */
  public get sampler(): GPUSampler {
    if (!this._sampler) {
      throw new Error('MipGenerator is not initialized');
    }

    return this._sampler;
  }

  /**
   * Initialize the MipGenerator
   * @param gpu The Gpu wrapper
   */
  public async init(gpu: Gpu): Promise<void> {
    this._sampler = gpu.device.createSampler({
      minFilter: 'linear',
    });
  }

  /**
   * Return the number of mip levels available for the given dimensions. The
   * sizes can be 1D, 2D 3D, ... ND.
   *
   * @param sizes the dimensions of the texture.
   * @returns 1 + log2(max(sizes));
   */
  public countMipLevels(...sizes: number[]): number {
    const maxSize = Math.max(...sizes);
    return (1 + Math.log2(maxSize)) | 0;
  }

  /**
   * Get the program to generate the mipmap for the given format.
   * If the program does not exist yet it is created.
   *
   * @param gpu The Gpu Wrapper
   * @param format The texture format
   * @returns the Program for the given format
   */
  public async getProgram(
    gpu: Gpu,
    format: GPUTextureFormat
  ): Promise<Program> {
    let program = this._programMap.get(format);
    if (program) {
      return program;
    }

    program = new Program();
    await program.init(gpu, {
      shaderDescriptor: () => ({
        label: 'mipmap shader',
        code: shaderCode,
      }),
      pipelineDescriptor: (module: GPUShaderModule) => ({
        label: 'mipmap pipeline',
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vs',
        },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format }],
        },
      }),
    });

    this._programMap.set(format, program);
    return program;
  }

  /**
   * Create the BindGroup for a given mipLevel of a texture.
   *
   * @param props.gpu: The Gpu Wrapper.
   * @param props.program: The program Wrapper .
   * @param props.texture: GPUTexture The texture to bind.
   * @param props.baseMipLevel: The mipmap level.
   * @returns The BindGroup for a given mipLevel of a texture.
   */
  public getBindGroup({
    gpu,
    program,
    texture,
    baseMipLevel,
  }: {
    gpu: Gpu;
    program: Program;
    texture: GPUTexture;
    baseMipLevel: number;
  }): GPUBindGroup {
    return gpu.device.createBindGroup({
      layout: program.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        {
          binding: 1,
          resource: texture.createView({ baseMipLevel, mipLevelCount: 1 }),
        },
      ],
    });
  }

  /**
   * Create the RenderPassDescriptor for a given mipLevel of a texture.
   * @param props.texture The texture to render.
   * @param props.baseMipLevel The mipmap level to render.
   * @returns The RenderPassDescriptor for a given mipLevel of a texture.
   */
  public getRenderPassDescriptor({
    texture,
    baseMipLevel,
  }: {
    texture: GPUTexture;
    baseMipLevel: number;
  }): GPURenderPassDescriptor {
    return {
      label: 'mimap renderPass',
      colorAttachments: [
        {
          view: texture.createView({ baseMipLevel, mipLevelCount: 1 }),
          clearValue: [0.0, 0.0, 0.0, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };
  }

  public renderMipmap({
    encoder,
    program,
    renderPassDescriptor,
    bindGroup,
  }: {
    encoder: GPUCommandEncoder;
    program: Program;
    renderPassDescriptor: GPURenderPassDescriptor;
    bindGroup: GPUBindGroup;
  }) {
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(program.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6); // call our vertex shader 6 times
    pass.end();
  }

  public async generate(
    gpu: Gpu,
    texture: GPUTexture,
    mipLevelCount?: number
  ): Promise<number> {
    const program = await this.getProgram(gpu, texture.format);
    const encoder = gpu.device.createCommandEncoder({
      label: 'mip gen encoder',
    });

    let width = texture.width;
    let height = texture.height;
    let baseMipLevel = 0;
    mipLevelCount = mipLevelCount ?? this.countMipLevels(width, height);

    while ((baseMipLevel < mipLevelCount && width > 1) || height > 1) {
      width = Math.max(1, (width / 2) | 0);
      height = Math.max(1, (height / 2) | 0);

      this.renderMipmap({
        bindGroup: this.getBindGroup({
          gpu,
          program,
          texture,
          baseMipLevel,
        }),
        encoder,
        program,
        renderPassDescriptor: this.getRenderPassDescriptor({
          texture,
          baseMipLevel: baseMipLevel + 1,
        }),
      });

      ++baseMipLevel;
    }

    const commandBuffer = encoder.finish();
    gpu.device.queue.submit([commandBuffer]);

    return baseMipLevel;
  }
}

export default MipGenerator;
