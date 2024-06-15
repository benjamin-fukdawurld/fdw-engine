import { Engine, Program } from '@fdw/render';

import shaderCode from '../../assets/basic-vertex.wgsl?raw';
import { mat4 } from 'wgpu-matrix';

export class Material {
  private _program: Program;
  private _bindGroup: GPUBindGroup | null;

  private _uniformValues: Float32Array | null;
  private _uniformBuffer: GPUBuffer | null;

  constructor() {
    this._program = new Program();
    this._bindGroup = null;
    this._uniformValues = null;
    this._uniformBuffer = null;
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
          buffers: [
            {
              arrayStride: 4 * 4,
              attributes: [
                {
                  shaderLocation: 0,
                  offset: 0,
                  format: 'float32x3',
                },
                {
                  shaderLocation: 1,
                  offset: 12,
                  format: 'unorm8x4',
                },
              ],
            },
          ],
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs',
          targets: [{ format: engine.surface.format }],
        },
        primitive: {
          cullMode: 'back',
        },
        depthStencil: {
          depthWriteEnabled: true,
          depthCompare: 'less',
          format: 'depth24plus',
        },
      }),
    });

    const uniformBufferSize = (4 + 16 * 3) * 4;
    this._uniformBuffer = engine.gpu.device.createBuffer({
      label: 'uniforms',
      size: uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformValues = new Float32Array(uniformBufferSize / 4);

    // offsets to the various uniform values in float32 indices
    const kColorOffset = 0;

    const colorValue = this._uniformValues.subarray(
      kColorOffset,
      kColorOffset + 4
    );

    // The color will not change so let's set it once at init time
    colorValue.set([Math.random(), Math.random(), Math.random(), 1]);

    const m = this.modelValue;
    mat4.identity(m);

    const p = this.projectionValue;
    mat4.identity(p);

    const c = this.cameraValue;
    mat4.identity(c);

    this._bindGroup = engine.gpu.device.createBindGroup({
      label: 'bind group for object',
      layout: this.program.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
    });
  }

  public get program(): Program {
    return this._program;
  }

  public get uniformValues(): Float32Array {
    if (!this._uniformValues) {
      throw new Error('Material is not initialized');
    }

    return this._uniformValues;
  }

  public get modelValue() {
    return this.uniformValues.subarray(0, 16);
  }

  public setModelValue(m: Float32Array) {
    return this.uniformValues.set(m, 0);
  }

  public get cameraValue() {
    return this.uniformValues.subarray(16, 32);
  }

  public setCameraValue(m: Float32Array) {
    return this.uniformValues.set(m, 16);
  }

  public get projectionValue() {
    return this.uniformValues.subarray(32, 48);
  }

  public setProjectionValue(m: Float32Array) {
    return this.uniformValues.set(m, 32);
  }

  public get bindGroup(): GPUBindGroup {
    if (!this._bindGroup) {
      throw new Error('Material is not initialized');
    }

    return this._bindGroup;
  }

  public get uniformBuffer(): GPUBuffer {
    if (!this._uniformBuffer) {
      throw new Error('Material is not initialized');
    }

    return this._uniformBuffer;
  }
}

export default Material;
