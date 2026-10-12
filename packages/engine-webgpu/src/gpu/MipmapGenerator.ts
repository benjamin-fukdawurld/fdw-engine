// Computes the levels of textures: WebGPU has no generateMipmap. Each level
// is rendered from the previous one by a full screen triangle averaging
// 2 × 2 texels. textureLoad rather than a sampler: the float formats that
// cannot be filtered (rgba32float) work too. Through views of the format of
// the texture, the sRGB textures are averaged in linear colors.
const shader = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // A side of 1 texel (4 × 1 → 2 × 1): its texel is read twice. An odd
  // side drops its last texel, as box filters do.
  let last = vec2i(textureDimensions(source)) - 1;
  let base = vec2i(position.xy) * 2;
  return (textureLoad(source, min(base, last), 0) +
    textureLoad(source, min(base + vec2i(1, 0), last), 0) +
    textureLoad(source, min(base + vec2i(0, 1), last), 0) +
    textureLoad(source, min(base + vec2i(1, 1), last), 0)) * 0.25;
}
`;

export class MipmapGenerator {
  private _module?: GPUShaderModule;
  private _layout?: GPUBindGroupLayout;
  private readonly _pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(private readonly _device: GPUDevice) {}

  /**
   * Records the computation of the levels of `texture` after the first one,
   * in every layer. The texture needs the texture-binding and
   * render-attachment usages.
   */
  encode(encoder: GPUCommandEncoder, texture: GPUTexture): void {
    const pipeline = this.pipeline(texture.format);
    const layout = this._layout as GPUBindGroupLayout;
    const view = (level: number, layer: number) =>
      texture.createView({
        dimension: '2d',
        baseMipLevel: level,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      });
    for (let layer = 0; layer < texture.depthOrArrayLayers; layer++) {
      for (let level = 1; level < texture.mipLevelCount; level++) {
        const pass = encoder.beginRenderPass({
          label: `${texture.label} mipmap ${level}`,
          colorAttachments: [
            { view: view(level, layer), loadOp: 'clear', storeOp: 'store' },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          this._device.createBindGroup({
            layout,
            entries: [{ binding: 0, resource: view(level - 1, layer) }],
          })
        );
        pass.draw(3);
        pass.end();
      }
    }
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this._pipelines.get(format);
    if (pipeline) {
      return pipeline;
    }
    this._module ??= this._device.createShaderModule({
      label: 'mipmaps',
      code: shader,
    });
    this._layout ??= this._device.createBindGroupLayout({
      label: 'mipmaps',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });
    pipeline = this._device.createRenderPipeline({
      label: `mipmaps ${format}`,
      layout: this._device.createPipelineLayout({
        bindGroupLayouts: [this._layout],
      }),
      vertex: { module: this._module, entryPoint: 'vertexMain' },
      fragment: {
        module: this._module,
        entryPoint: 'fragmentMain',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this._pipelines.set(format, pipeline);
    return pipeline;
  }
}
