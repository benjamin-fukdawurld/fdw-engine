import {
  Vec2View,
  Vec3View,
  Vec4View,
  QuatView,
  WriterApi,
} from '@fdw/engine-backend';

import { uniformLayout } from './layouts';

export const uniformWriters: WriterApi = {
  bool: {
    write(target: ArrayBuffer, offset: number, value: boolean): void {
      const view = new DataView(target, offset, uniformLayout.bool.size);
      view.setUint32(0, value ? 1 : 0, true);
    },
  },

  int32: {
    write(target: ArrayBuffer, offset: number, value: number): void {
      const view = new DataView(target, offset, uniformLayout.int32.size);
      view.setInt32(0, value, true);
    },
  },

  uint32: {
    write(target: ArrayBuffer, offset: number, value: number): void {
      const view = new DataView(target, offset, uniformLayout.uint32.size);
      view.setUint32(0, value, true);
    },
  },

  float32: {
    write(target: ArrayBuffer, offset: number, value: number): void {
      const view = new DataView(target, offset, uniformLayout.float32.size);
      view.setFloat32(0, value, true);
    },
  },

  vec2: {
    write(target: ArrayBuffer, offset: number, value: Vec2View): void {
      const view = new DataView(target, offset, uniformLayout.vec2.size);
      view.setFloat32(0, value.x, true);
      view.setFloat32(4, value.y, true);
    },
  },

  vec2i: {
    write(target: ArrayBuffer, offset: number, value: Vec2View): void {
      const view = new DataView(target, offset, uniformLayout.vec2i.size);
      view.setInt32(0, value.x, true);
      view.setInt32(4, value.y, true);
    },
  },

  vec2u: {
    write(target: ArrayBuffer, offset: number, value: Vec2View): void {
      const view = new DataView(target, offset, uniformLayout.vec2u.size);
      view.setUint32(0, value.x, true);
      view.setUint32(4, value.y, true);
    },
  },

  vec3: {
    write(target: ArrayBuffer, offset: number, value: Vec3View): void {
      const view = new DataView(target, offset, uniformLayout.vec3.size);
      view.setFloat32(0, value.x, true);
      view.setFloat32(4, value.y, true);
      view.setFloat32(8, value.z, true);
    },
  },

  vec3i: {
    write(target: ArrayBuffer, offset: number, value: Vec3View): void {
      const view = new DataView(target, offset, uniformLayout.vec3i.size);
      view.setInt32(0, value.x, true);
      view.setInt32(4, value.y, true);
      view.setInt32(8, value.z, true);
    },
  },

  vec3u: {
    write(target: ArrayBuffer, offset: number, value: Vec3View): void {
      const view = new DataView(target, offset, uniformLayout.vec3u.size);
      view.setUint32(0, value.x, true);
      view.setUint32(4, value.y, true);
      view.setUint32(8, value.z, true);
    },
  },

  vec4: {
    write(target: ArrayBuffer, offset: number, value: Vec4View): void {
      const view = new DataView(target, offset, uniformLayout.vec4.size);
      view.setFloat32(0, value.x, true);
      view.setFloat32(4, value.y, true);
      view.setFloat32(8, value.z, true);
      view.setFloat32(12, value.w, true);
    },
  },

  vec4i: {
    write(target: ArrayBuffer, offset: number, value: Vec4View): void {
      const view = new DataView(target, offset, uniformLayout.vec4i.size);
      view.setInt32(0, value.x, true);
      view.setInt32(4, value.y, true);
      view.setInt32(8, value.z, true);
      view.setInt32(12, value.w, true);
    },
  },

  vec4u: {
    write(target: ArrayBuffer, offset: number, value: Vec4View): void {
      const view = new DataView(target, offset, uniformLayout.vec4u.size);
      view.setUint32(0, value.x, true);
      view.setUint32(4, value.y, true);
      view.setUint32(8, value.z, true);
      view.setUint32(12, value.w, true);
    },
  },

  quat: {
    write(target: ArrayBuffer, offset: number, value: QuatView): void {
      const view = new DataView(target, offset, uniformLayout.quat.size);
      view.setFloat32(0, value.x, true);
      view.setFloat32(4, value.y, true);
      view.setFloat32(8, value.z, true);
      view.setFloat32(12, value.w, true);
    },
  },

  mat2: {
    write(target: ArrayBuffer, offset: number, value: Float32Array): void {
      const view = new DataView(target, offset, uniformLayout.mat2.size);
      view.setFloat32(0, value[0], true);
      view.setFloat32(4, value[1], true);
      view.setFloat32(8, value[2], true);
      view.setFloat32(12, value[3], true);
    },
  },

  mat3: {
    write(target: ArrayBuffer, offset: number, value: Float32Array): void {
      const view = new DataView(target, offset, uniformLayout.mat3.size);
      for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
          view.setFloat32(column * 16 + row * 4, value[column * 3 + row], true);
        }
      }
    },
  },

  mat4: {
    write(target: ArrayBuffer, offset: number, value: Float32Array): void {
      const view = new DataView(target, offset, uniformLayout.mat4.size);
      for (let i = 0; i < 16; i++) {
        view.setFloat32(i * 4, value[i], true);
      }
    },
  },
};
