import { Eta } from 'eta';

import { MeshAttributeDescription } from '@fdw/engine-backend';

import baseTemplate from './templates/layouts/base-shader.wgsl.eta?raw';
import phongTemplate from './templates/phong/phong-shader.wgsl.eta?raw';
import vertexAttributeTemplate from './templates/common/vertex-attributes.wgsl.eta?raw';
import uniformsTemplate from './templates/common/uniforms.wgsl.eta?raw';
import texturesTemplate from './templates/common/textures.wgsl.eta?raw';
import functionsTemplate from './templates/phong/functions.wgsl.eta?raw';

const eta = new Eta({
  views: import.meta.url,
});

eta.loadTemplate('@base', baseTemplate);
eta.loadTemplate('@phong', phongTemplate);
eta.loadTemplate('@vertex-attributes', vertexAttributeTemplate);
eta.loadTemplate('@uniforms', uniformsTemplate);
eta.loadTemplate('@functions', functionsTemplate);
eta.loadTemplate('@textures', texturesTemplate);

export class ShaderWritter {
  static readonly eta = eta;

  static readonly baseTemplate = baseTemplate;

  static formatAttributeType(attr: MeshAttributeDescription): string {
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

  static render(template: string, data: Record<string, any>): string {
    return ShaderWritter.eta.render(template, {
      ...data,
      $ctx: {
        formatAttributeType: ShaderWritter.formatAttributeType,
      },
    });
  }
}
