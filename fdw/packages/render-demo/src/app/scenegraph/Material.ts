import { Engine, Program } from '@fdw/render';

import shaderCode from '../../assets/basic.wgsl?raw';
import textureImage from '../../assets/f-texture.png';

export class Material {
  private _program: Program;
  private _texture: GPUTexture | null;
  private _sampler: GPUSampler | null;
  private _matBuffer: GPUBuffer | null;
  private _bindGroup: GPUBindGroup | null;

  constructor() {
    this._program = new Program();
    this._texture = null;
    this._sampler = null;
    this._matBuffer = null;
    this._bindGroup = null;
  }

  async init(engine: Engine) {
    this._program.init(engine.gpu, {
      shaderDescriptor: () => ({
        label: `shaders`,
        code: shaderCode,
      }),
      pipelineDescriptor: (shaderModule: GPUShaderModule) => ({
        label: `pipeline`,
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vs',
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs',
          targets: [{ format: engine.surface.format }],
        },
      }),
    });

    this._texture = await engine.texLoader.loadTexture(
      engine.gpu,
      textureImage
    );

    this._sampler = engine.gpu.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
    });

    const uniformBufferSize = 4 * 3 * 16; //sizeof(float) * 3 * mat4x4f
    this._matBuffer = engine.gpu.device.createBuffer({
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._bindGroup = engine.gpu.device.createBindGroup({
      layout: this.program.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: { buffer: this._matBuffer } },
      ],
    });
  }

  public get program(): Program {
    return this._program;
  }

  public get texture(): GPUTexture {
    if (!this._texture) {
      throw new Error('Material is not initialized');
    }

    return this._texture;
  }

  public get sampler(): GPUSampler {
    if (!this._sampler) {
      throw new Error('Material is not initialized');
    }

    return this._sampler;
  }

  public get bindGroup(): GPUBindGroup {
    if (!this._bindGroup) {
      throw new Error('Material is not initialized');
    }

    return this._bindGroup;
  }

  public get matBuffer(): GPUBuffer {
    if (!this._matBuffer) {
      throw new Error('Material is not initialized');
    }

    return this._matBuffer;
  }
}

export default Material;
