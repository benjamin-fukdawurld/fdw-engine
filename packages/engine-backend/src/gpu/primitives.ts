import { QuatView, Vec2View, Vec3View, Vec4View } from '../math';
import { GpuLayout } from './GpuLayout';
import { GpuType } from './GpuType';
import { GpuWriter } from './GpuWriter';
import { LayoutApi } from './layouts';
import { WriterApi } from './writers';

export type PrimitiveApi = {
  bool: GpuType<boolean>;
  int32: GpuType<number>;
  uint32: GpuType<number>;
  float32: GpuType<number>;
  vec2: GpuType<Vec2View>;
  vec2i: GpuType<Vec2View>;
  vec2u: GpuType<Vec2View>;
  vec3: GpuType<Vec3View>;
  vec3i: GpuType<Vec3View>;
  vec3u: GpuType<Vec3View>;
  vec4: GpuType<Vec4View>;
  vec4i: GpuType<Vec4View>;
  vec4u: GpuType<Vec4View>;
  quat: GpuType<QuatView>;
  mat2: GpuType<Float32Array>;
  mat3: GpuType<Float32Array>;
  mat4: GpuType<Float32Array>;
};

export function primitiveOf<T>({
  layout,
  writer,
}: {
  layout: GpuLayout;
  writer: GpuWriter<T>;
}): GpuType<T> {
  return {
    size: layout.size,
    alignment: layout.alignment,

    write(target: ArrayBuffer, offset: number, value: T): void {
      writer.write(target, offset, value);
    },
  };
}

export function primitiveApi({
  layouts,
  writers,
}: {
  layouts: LayoutApi;
  writers: WriterApi;
}): PrimitiveApi {
  return {
    bool: primitiveOf<boolean>({ layout: layouts.bool, writer: writers.bool }),
    int32: primitiveOf<number>({
      layout: layouts.int32,
      writer: writers.int32,
    }),
    uint32: primitiveOf<number>({
      layout: layouts.uint32,
      writer: writers.uint32,
    }),
    float32: primitiveOf<number>({
      layout: layouts.float32,
      writer: writers.float32,
    }),
    vec2: primitiveOf<Vec2View>({ layout: layouts.vec2, writer: writers.vec2 }),
    vec2i: primitiveOf<Vec2View>({
      layout: layouts.vec2i,
      writer: writers.vec2i,
    }),
    vec2u: primitiveOf<Vec2View>({
      layout: layouts.vec2u,
      writer: writers.vec2u,
    }),
    vec3: primitiveOf<Vec3View>({ layout: layouts.vec3, writer: writers.vec3 }),
    vec3i: primitiveOf<Vec3View>({
      layout: layouts.vec3i,
      writer: writers.vec3i,
    }),
    vec3u: primitiveOf<Vec3View>({
      layout: layouts.vec3u,
      writer: writers.vec3u,
    }),
    vec4: primitiveOf<Vec4View>({ layout: layouts.vec4, writer: writers.vec4 }),
    vec4i: primitiveOf<Vec4View>({
      layout: layouts.vec4i,
      writer: writers.vec4i,
    }),
    vec4u: primitiveOf<Vec4View>({
      layout: layouts.vec4u,
      writer: writers.vec4u,
    }),
    quat: primitiveOf<QuatView>({ layout: layouts.quat, writer: writers.quat }),
    mat2: primitiveOf<Float32Array>({
      layout: layouts.mat2,
      writer: writers.mat2,
    }),
    mat3: primitiveOf<Float32Array>({
      layout: layouts.mat3,
      writer: writers.mat3,
    }),
    mat4: primitiveOf<Float32Array>({
      layout: layouts.mat4,
      writer: writers.mat4,
    }),
  };
}
