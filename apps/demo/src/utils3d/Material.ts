import {
  GpuArray,
  GpuStruct,
  GpuType,
  MeshAttributeDescription,
} from '@fdw/engine-backend';
import { ShaderWritter, Buffer, Texture, Sampler } from '@fdw/engine-webgpu';

export type MaterialUniformType<T = unknown> =
  | GpuType<T>
  | GpuArray<T>
  | GpuStruct<T>;

export type UniformBufferStage = 'vertex' | 'fragment' | 'compute';

export type MaterialUniformDescription<T = unknown> = {
  name: string;
  type: MaterialUniformType<T>;
  value: T;
  stages: UniformBufferStage[];
};

export class Material {
  type: string;
  attributes: MeshAttributeDescription[];
  frameUniforms: MaterialUniformDescription[];
  materialUniforms: MaterialUniformDescription[];
  objectUniforms: MaterialUniformDescription[];

  textures: { texture: Texture; sampler: Sampler }[];

  constructor(options: {
    type: string;
    attributes?: MeshAttributeDescription[];
  }) {
    this.type = options.type;
    this.attributes = options.attributes ?? [];
    this.frameUniforms = [];
    this.materialUniforms = [];
    this.objectUniforms = [];
    this.textures = [];
  }

  getVertexBufferLayout(): GPUVertexBufferLayout {
    return {
      arrayStride: this.attributes.reduce((sum, attr) => {
        switch (attr.format) {
          case 'float32x4':
          case 'uint32x4':
            return sum + 4 * 4;
          case 'float32x3':
          case 'uint32x3':
            return sum + 3 * 4;
          case 'float32x2':
          case 'uint32x2':
            return sum + 2 * 4;
          case 'float32':
          case 'uint32':
          case 'sint32':
            return sum + 4;
          case 'uint16':
          case 'sint16':
          case 'unorm16':
          case 'snorm16':
            return sum + 2;
          case 'uint8':
          case 'sint8':
          case 'unorm8':
          case 'snorm8':
            return sum + 1;
          default:
            return sum;
        }
      }, 0),
      stepMode: 'vertex',
      attributes: this.attributes.map((attr, index) => {
        return {
          shaderLocation: index,
          offset: attr.offset,
          format: attr.format,
        };
      }),
    };
  }
}

export class MaterialAdapter {
  static uniformBufferStageToWebGpu(
    stage: UniformBufferStage
  ): GPUShaderStageFlags {
    switch (stage) {
      case 'vertex':
        return GPUShaderStage.VERTEX;
      case 'fragment':
        return GPUShaderStage.FRAGMENT;
      case 'compute':
        return GPUShaderStage.COMPUTE;
      default:
        throw new Error(`Unknown uniform buffer stage: ${stage}`);
    }
  }

  static getBindGroupLayoutEntry({
    binding,
    uniform,
    texture,
  }:
    | {
        binding: number;
        uniform: MaterialUniformDescription;
        texture?: never;
      }
    | {
        binding: number;
        uniform?: never;
        texture: { texture: Texture; sampler: Sampler };
      }): GPUBindGroupLayoutEntry[] {
    if (texture) {
      return [
        {
          binding,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          texture: {},
        },
        {
          binding: binding + 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          sampler: {},
        },
      ];
    }

    return [
      {
        binding,
        visibility: uniform.stages.reduce((visibility, stage) => {
          return visibility | MaterialAdapter.uniformBufferStageToWebGpu(stage);
        }, 0),
        buffer: {},
      },
    ];
  }

  static getBindGroupLayout(
    uniforms: MaterialUniformDescription[],
    textures: { texture: Texture; sampler: Sampler }[]
  ): GPUBindGroupLayoutDescriptor {
    const entries = [
      ...uniforms
        .map((uniform, binding) => {
          return MaterialAdapter.getBindGroupLayoutEntry({ binding, uniform });
        })
        .flat(),
      ...textures
        .map((texture, binding) => {
          return MaterialAdapter.getBindGroupLayoutEntry({
            binding: uniforms.length + binding * 2,
            texture,
          });
        })
        .flat(),
    ];

    console.log('Bind group layout entries:', entries);
    return {
      entries,
    };
  }

  static createBindGroup(
    device: GPUDevice,
    uniforms: MaterialUniformDescription[],
    tex: { texture: Texture; sampler: Sampler }[]
  ): { bindgroup: GPUBindGroup; layout: GPUBindGroupLayout } {
    const bindGroupLayout = device.createBindGroupLayout(
      MaterialAdapter.getBindGroupLayout(uniforms, tex)
    );

    const textureBindings = tex
      .map((texture, index): [GPUBindGroupEntry, GPUBindGroupEntry] => {
        return [
          {
            binding: uniforms.length + index * 2,
            resource: texture.texture.view!,
          },
          {
            binding: uniforms.length + index * 2 + 1,
            resource: texture.sampler.sampler!,
          },
        ];
      })
      .flat();

    return {
      bindgroup: device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          ...uniforms.map((uniform, index) => {
            return {
              binding: index,
              resource: {
                buffer: (uniform.value as Buffer).buffer,
              },
            };
          }),
          ...textureBindings,
        ],
      }),
      layout: bindGroupLayout,
    };
  }

  static attributeTypeFormatter(attr: MeshAttributeDescription): string {
    switch (attr.format) {
      case 'float32x4':
      case 'float16x4':
      case 'snorm16x4':
      case 'snorm8x4':
      case 'unorm16x4':
      case 'unorm8x4':
        return 'vec4<f32>';
      case 'float32x3':
        return 'vec3<f32>';
      case 'float32x2':
      case 'float16x2':
      case 'snorm16x2':
      case 'snorm8x2':
      case 'unorm16x2':
      case 'unorm8x2':
        return 'vec2<f32>';
      case 'float32':
      case 'float16':
      case 'snorm16':
      case 'snorm8':
      case 'unorm16':
      case 'unorm8':
        return 'f32';
      case 'uint32x4':
      case 'uint16x4':
      case 'uint8x4':
        return 'vec4<u32>';
      case 'uint32x3':
        return 'vec3<u32>';
      case 'uint32x2':
      case 'uint16x2':
      case 'uint8x2':
        return 'vec2<u32>';
      case 'uint32':
      case 'uint16':
      case 'uint8':
        return 'u32';
      case 'sint32x4':
      case 'sint16x4':
      case 'sint8x4':
        return 'vec4<i32>';
      case 'sint32x3':
        return 'vec3<i32>';
      case 'sint32x2':
      case 'sint16x2':
      case 'sint8x2':
        return 'vec2<i32>';
      case 'sint32':
      case 'sint16':
      case 'sint8':
        return 'i32';
      default:
        throw new Error(`Unsupported attribute format: ${attr.format}`);
    }
  }

  static getShaderSource(mat: Material): string {
    const wgsl = ShaderWritter.render('@phong', {
      material: mat,
      ambientColor: 'ambientLightColor',
      diffuseColor: 'diffuseColor',
      specularColor: 'specularColor',
      shininess: 'shininess',
      diffuseTexture: 'diffuseTexture',
      diffuseTextureSampler: 'diffuseTextureSampler',
      specularTexture: 'specularTexture',
      specularTextureSampler: 'specularTextureSampler',
      shininessTexture: 'shininessTexture',
      shininessTextureSampler: 'shininessTextureSampler',
      shininessTextureChannel: 'r',
      uv: true,
    });

    console.log(wgsl);

    return wgsl;
  }

  static getShaderModule(
    device: GPUDevice,
    material: Material
  ): GPUShaderModule {
    return device.createShaderModule({
      code: MaterialAdapter.getShaderSource(material),
    });
  }
}
