import type { MeshDescription } from '@fdw/engine-backend';
import {
  compile,
  GraphBuilder,
  MaterialGraphData,
  std,
  stdMacros,
  T,
} from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebGpuEngine } from '../WebGpuEngine';

// Validates the generated WGSL and the pipelines with Dawn, the WebGPU
// implementation of Chrome, running in Node. Skipped where Dawn cannot load.
const dawn = await import('webgpu').catch(() => undefined);

const mesh: MeshDescription = {
  vertexBuffers: [
    {
      stride: 64,
      stepMode: 'vertex',
      attributes: [
        { semantic: 'position', format: 'float32x3', offset: 0 },
        { semantic: 'normal', format: 'float32x3', offset: 12 },
        { semantic: 'uv', format: 'float32x2', offset: 24 },
        { semantic: 'color', format: 'float32x4', offset: 32 },
        { semantic: 'tangent', format: 'float32x4', offset: 48 },
      ],
    },
    {
      stride: 4,
      stepMode: 'vertex',
      attributes: [{ semantic: 'materialId', format: 'uint32', offset: 0 }],
    },
  ],
  vertexCount: 3,
};

const graphs: Record<string, () => MaterialGraphData> = {
  'textured unlit': () => {
    const g = new GraphBuilder('textured');
    const texel = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv: g.attribute('uv', T.vec2f),
    });
    const tint = g.uniform('tint', T.vec4f);
    const color = g.call(std.mul, { a: texel, b: tint });
    g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
    return g.build();
  },
  'constant color': () => {
    const g = new GraphBuilder('constant');
    g.surface({ baseColor: [1, 0, 0] });
    return g.build();
  },
  'WGSL reserved words as names': () => {
    const g = new GraphBuilder('reserved');
    g.surface({
      baseColor: g.call(std.mix, {
        a: g.uniform('from', T.vec3f),
        b: g.uniform('to', T.vec3f),
        t: g.uniform('type', T.f32),
      }),
      alpha: g
        .call(std.textureSample, {
          texture: g.texture('module'),
          sampler: g.sampler('self'),
          uv: g.attribute('uv', T.vec2f),
        })
        .swizzle('a'),
    });
    return g.build();
  },
  'builtin function names as names': () => {
    const g = new GraphBuilder('builtins');
    g.surface({
      baseColor: g.call(std.normalize, { x: g.uniform('normalize', T.vec3f) }),
      alpha: g.uniform('min', T.f32),
    });
    return g.build();
  },
  'vertex animation, intrinsics, integers and custom slots': () => {
    const g = new GraphBuilder('animated');
    const normal = g.attribute('normal', T.vec3f);
    const wave = g.call(std.sin, { x: g.engine('time') });
    const offset = g.call(std.mul, {
      a: g.call(std.normalize, { x: normal }),
      b: g.call(std.mul, { a: wave, b: 0.1 }),
    });
    const lit = g.call(std.saturate, {
      x: g.call(std.dot, { a: normal, b: [0, 1, 0] }),
    });
    const fresnel = g.call(std.pow, {
      base: g.call(std.sub, { a: 1, b: lit }),
      exponent: 5,
    });
    const color = g.attribute('color', T.vec4f);
    const mixed = g.call(std.mix, {
      a: color.swizzle('rgb'),
      b: [1, 1, 1],
      t: fresnel,
    });
    const index = g.uniform('paletteIndex', T.u32, { slot: 'custom' });
    const id = g.attribute('materialId', T.u32);
    const chosen = g.call(std.select, {
      ifFalse: id,
      ifTrue: index,
      condition: g.builtin('front-facing'),
    });
    const scale = g.call(
      std.convert,
      { value: chosen },
      { params: { to: T.f32 } }
    );
    g.surface({
      baseColor: g.call(std.clamp, { x: mixed, low: 0, high: scale }),
      positionOffset: offset,
    });
    return g.build();
  },
  'phong, textured, with emissive': () => {
    const g = new GraphBuilder('phong');
    const uv = g.attribute('uv', T.vec2f);
    const sample = (name: string) =>
      g.call(std.textureSample, {
        texture: g.texture(name),
        sampler: g.sampler(`${name}Sampler`),
        uv,
      });
    g.surface({
      shadingModel: 'phong',
      baseColor: sample('diffuse').swizzle('rgb'),
      specular: sample('specular').swizzle('rgb'),
      shininess: g.call(std.mul, {
        a: sample('shininess').swizzle('r'),
        b: 255,
      }),
      emissive: g.uniform('emissive', T.vec3f),
    });
    return g.build();
  },
  'phong with normal mapping (tangents)': () => {
    const g = new GraphBuilder('normal-mapped');
    const sample = g.call(std.textureSample, {
      texture: g.texture('normalMap'),
      sampler: g.sampler('normalSampler'),
      uv: g.attribute('uv', T.vec2f),
    });
    g.surface({
      shadingModel: 'phong',
      normal: g.call(stdMacros.normalMapping, {
        sample: sample.swizzle('rgb'),
      }),
    });
    return g.build();
  },
  'raw stage outputs': () => {
    const g = new GraphBuilder('raw');
    const position = g.attribute('position', T.vec3f);
    g.node('output.vertex', {
      inputs: {
        clipPosition: g.call(std.transform, {
          matrix: g.engine('camera.viewProjection'),
          vector: g.call(std.extend, { xyz: position }),
        }),
      },
    });
    g.node('output.fragment', {
      inputs: {
        color: g.call(std.extend, { xyz: g.call(std.fract, { x: position }) }),
      },
    });
    return g.build();
  },
};

describe.skipIf(!dawn)('generated WGSL, validated by Dawn', () => {
  let engine: WebGpuEngine;

  beforeAll(async () => {
    Object.assign(globalThis, dawn!.globals);
    engine = new WebGpuEngine({ gpu: dawn!.create([]) });
    await engine.init();
  });

  afterAll(() => engine?.destroy());

  // Control test: the error scope does catch invalid shaders.
  it('reports invalid WGSL', async () => {
    const device = engine.device!;
    device.pushErrorScope('validation');
    device.createShaderModule({ code: 'struct S { from: f32 };' });
    const error = await device.popErrorScope();
    expect(error?.message).toMatch(/reserved/);
  });

  it.each(Object.keys(graphs))(
    '%s: compiles and creates a pipeline',
    async (name) => {
      const backend = engine.backend!;
      const device = engine.device!;
      const program = compile(graphs[name](), {
        vertexAttributes: mesh.vertexBuffers.flatMap((buffer) =>
          buffer.attributes.map((attribute) => attribute.semantic)
        ),
      });

      device.pushErrorScope('validation');
      backend.pipelines.createRenderPipeline({
        program,
        vertex: mesh,
        primitive: {
          topology: 'triangle-list',
          cullMode: 'back',
          frontFace: 'ccw',
        },
        depthStencil: {
          format: 'depth24plus',
          depthWrite: true,
          depthCompare: 'less',
        },
        targets: [{ format: 'rgba8unorm' }],
      });
      const error = await device.popErrorScope();

      expect(error?.message).toBeUndefined();
    }
  );
});
