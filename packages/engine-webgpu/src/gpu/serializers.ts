import { SerializerApi } from '@fdw/engine-backend';

function arrayFormatter(type: string, length?: number): string {
  return `array<${type}${length ? `, ${length}` : ''}>`;
}

export const uniformSerializers: SerializerApi = {
  bool: {
    serialize(): string {
      return 'bool';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('bool', length);
    },
  },

  int32: {
    serialize(): string {
      return 'i32';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('i32', length);
    },
  },

  uint32: {
    serialize(): string {
      return 'u32';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('u32', length);
    },
  },

  float32: {
    serialize(): string {
      return 'f32';
    },

    serializeArray(length?: number): string {
      return arrayFormatter('f32', length);
    },
  },

  vec2: {
    serialize(): string {
      return 'vec2<f32>';
    },

    serializeArray(length?: number): string {
      return arrayFormatter('vec2<f32>', length);
    },
  },

  vec2i: {
    serialize(): string {
      return 'vec2<i32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec2<i32>', length);
    },
  },

  vec2u: {
    serialize(): string {
      return 'vec2<u32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec2<u32>', length);
    },
  },

  vec3: {
    serialize(): string {
      return 'vec3<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec3<f32>', length);
    },
  },

  vec3i: {
    serialize(): string {
      return 'vec3<i32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec3<i32>', length);
    },
  },

  vec3u: {
    serialize(): string {
      return 'vec3<u32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec3<u32>', length);
    },
  },

  vec4: {
    serialize(): string {
      return 'vec4<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec4<f32>', length);
    },
  },

  vec4i: {
    serialize(): string {
      return 'vec4<i32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec4<i32>', length);
    },
  },

  vec4u: {
    serialize(): string {
      return 'vec4<u32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec4<u32>', length);
    },
  },

  quat: {
    serialize(): string {
      return 'vec4<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('vec4<f32>', length);
    },
  },

  mat2: {
    serialize(): string {
      return 'mat2x2<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('mat2x2<f32>', length);
    },
  },

  mat3: {
    serialize(): string {
      return 'mat3x3<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('mat3x3<f32>', length);
    },
  },

  mat4: {
    serialize(): string {
      return 'mat4x4<f32>';
    },
    serializeArray(length?: number): string {
      return arrayFormatter('mat4x4<f32>', length);
    },
  },
};
