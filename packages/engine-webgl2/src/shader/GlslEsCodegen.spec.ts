import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import {
  BuiltinTypes,
  compile,
  GraphBuilder,
  IrEntryPoint,
  IrInstruction,
  ShaderModuleIR,
  std,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { combinedSamplers } from './combinedSamplers';
import { GlslEsCodegen, glslSamplerType, glslType } from './GlslEsCodegen';
import { std140LayoutStrategy } from './std140LayoutStrategy';

const codegen = new GlslEsCodegen();

const emit = (
  module: ShaderModuleIR,
  layout: PhysicalProgramLayout = { groups: [] }
) => {
  const sources = codegen.emit(module, layout);
  if (sources.kind !== 'per-stage') {
    throw new Error('expected one source per stage');
  }
  return sources;
};

const clipPosition = {
  name: 'clipPosition',
  type: BuiltinTypes.vec4f,
  builtin: 'position' as const,
};

// A module whose fragment stage is the given body.
const fragmentModule = (
  body: IrInstruction[],
  result = body[body.length - 1].id
): ShaderModuleIR => {
  const vertex: IrEntryPoint = {
    stage: 'vertex',
    inputs: [],
    outputs: [clipPosition],
    body: [
      {
        id: 1,
        type: BuiltinTypes.vec4f,
        op: { kind: 'constant', value: [0, 0, 0, 1] },
        args: [],
      },
    ],
    results: { clipPosition: 1 },
  };
  const fragment: IrEntryPoint = {
    stage: 'fragment',
    inputs: [clipPosition],
    outputs: [{ name: 'color', type: BuiltinTypes.vec4f, location: 0 }],
    body,
    results: { color: result },
  };
  return { name: 'test', entryPoints: [vertex, fragment] };
};

const textureLayout: PhysicalProgramLayout = {
  groups: [
    {
      index: 0,
      slot: 'material',
      bindings: [
        {
          binding: 0,
          resource: {
            kind: 'texture',
            name: 'map',
            type: BuiltinTypes.texture2d,
          },
        },
        {
          binding: 1,
          resource: { kind: 'sampler', name: 'mapSampler', comparison: false },
        },
      ],
    },
  ],
};

const sampleBody = (): IrInstruction[] => [
  {
    id: 1,
    type: BuiltinTypes.texture2d,
    op: { kind: 'load-resource', binding: 'map' },
    args: [],
  },
  {
    id: 2,
    type: BuiltinTypes.sampler,
    op: { kind: 'load-resource', binding: 'mapSampler' },
    args: [],
  },
  {
    id: 3,
    type: BuiltinTypes.vec2f,
    op: { kind: 'constant', value: [0.5, 0.5] },
    args: [],
  },
  {
    id: 4,
    type: BuiltinTypes.vec4f,
    op: { kind: 'sample' },
    args: [1, 2, 3],
    name: 'texel',
    sourceNode: 'n4',
  },
];

describe('glslType', () => {
  it.each([
    [BuiltinTypes.f32, 'float'],
    [BuiltinTypes.vec3u, 'uvec3'],
    [BuiltinTypes.mat3f, 'mat3'],
    [{ kind: 'matrix', columns: 2, rows: 3, scalar: 'f32' } as const, 'mat2x3'],
  ])('%j → %s', (type, expected) => {
    expect(glslType(type)).toBe(expected);
  });

  it('maps textures to combined sampler types', () => {
    expect(glslSamplerType(BuiltinTypes.texture2d)).toBe('sampler2D');
    expect(glslSamplerType(BuiltinTypes.textureCube)).toBe('samplerCube');
    expect(
      glslSamplerType({ kind: 'texture', dimension: '3d', sampleType: 'uint' })
    ).toBe('usampler3D');
  });

  it('rejects types that GLSL ES cannot express', () => {
    expect(() => glslType(BuiltinTypes.texture2d)).toThrow(/not supported/);
    expect(() =>
      glslSamplerType({
        kind: 'texture',
        dimension: '2d',
        sampleType: 'float',
        multisampled: true,
      })
    ).toThrow(/cannot be sampled/);
  });
});

describe('GlslEsCodegen', () => {
  it('writes typed literals', () => {
    const { fragment } = emit(
      fragmentModule([
        {
          id: 1,
          type: BuiltinTypes.f32,
          op: { kind: 'constant', value: 1 },
          args: [],
        },
        {
          id: 2,
          type: BuiltinTypes.i32,
          op: { kind: 'constant', value: -2 },
          args: [],
        },
        {
          id: 3,
          type: BuiltinTypes.u32,
          op: { kind: 'constant', value: 3 },
          args: [],
        },
        {
          id: 4,
          type: BuiltinTypes.vec4f,
          op: { kind: 'constant', value: [1, 0.5, 0, 1] },
          args: [],
        },
      ])
    );
    expect(fragment).toContain('float v1 = 1.0;');
    expect(fragment).toContain('int v2 = -2;');
    expect(fragment).toContain('uint v3 = 3u;');
    expect(fragment).toContain('vec4 v4 = vec4(1.0, 0.5, 0.0, 1.0);');
  });

  it('combines the textures and samplers used together', () => {
    const module = fragmentModule(sampleBody());
    expect(combinedSamplers(module, textureLayout)).toEqual([
      {
        name: 'ts0_map_mapSampler',
        texture: 'map',
        sampler: 'mapSampler',
        type: BuiltinTypes.texture2d,
      },
    ]);
    const { vertex, fragment } = emit(module, textureLayout);
    expect(fragment).toContain('precision highp sampler2D;');
    expect(fragment).toContain('uniform sampler2D ts0_map_mapSampler;');
    expect(fragment).toContain(
      'vec4 v4_texel = texture(ts0_map_mapSampler, v3); // #n4'
    );
    // Declared in both stages, as GLSL requires shared uniforms to match.
    expect(vertex).toContain('uniform sampler2D ts0_map_mapSampler;');
  });

  it('selects with a ternary or per component', () => {
    const { fragment } = emit(
      fragmentModule([
        {
          id: 1,
          type: BuiltinTypes.bool,
          op: { kind: 'load-builtin', builtin: 'front-facing' },
          args: [],
        },
        {
          id: 2,
          type: BuiltinTypes.vec4f,
          op: { kind: 'load-builtin', builtin: 'frag-coord' },
          args: [],
        },
        {
          id: 3,
          type: BuiltinTypes.vec4f,
          op: { kind: 'constant', value: [0, 0, 0, 0] },
          args: [],
        },
        {
          id: 4,
          type: BuiltinTypes.vec4f,
          op: { kind: 'select' },
          args: [3, 2, 1],
        },
        {
          id: 5,
          type: { kind: 'vector', size: 2, scalar: 'bool' },
          op: { kind: 'constant', value: [1, 0] },
          args: [],
        },
        {
          id: 6,
          type: BuiltinTypes.vec2f,
          op: { kind: 'swizzle', components: 'xy' },
          args: [2],
        },
        {
          id: 7,
          type: BuiltinTypes.vec2f,
          op: { kind: 'select' },
          args: [6, 6, 5],
        },
        {
          id: 8,
          type: { kind: 'vector', size: 2, scalar: 'i32' },
          op: { kind: 'constant', value: [1, 2] },
          args: [],
        },
        {
          id: 9,
          type: { kind: 'vector', size: 2, scalar: 'i32' },
          op: { kind: 'select' },
          args: [8, 8, 5],
        },
        {
          id: 10,
          type: BuiltinTypes.vec4f,
          op: { kind: 'construct' },
          args: [7, 7],
        },
      ])
    );
    expect(fragment).toContain('vec4 v2 = gl_FragCoord;');
    expect(fragment).toContain('vec4 v4 = (v1 ? v2 : v3);');
    expect(fragment).toContain('vec2 v7 = mix(v6, v6, v5);');
    expect(fragment).toContain(
      'ivec2 v9 = ivec2(v5.x ? v8.x : v8.x, v5.y ? v8.y : v8.y);'
    );
  });

  it('declares flat varyings and remaps the clip space depth', () => {
    const module = fragmentModule([
      {
        id: 1,
        type: BuiltinTypes.vec4f,
        op: { kind: 'constant', value: [1, 1, 1, 1] },
        args: [],
      },
    ]);
    const varying = {
      name: 'v_id',
      type: BuiltinTypes.u32,
      location: 0,
      interpolation: 'flat' as const,
    };
    const [vertex, fragment] = module.entryPoints;
    const sources = emit({
      ...module,
      entryPoints: [
        {
          ...vertex,
          body: [
            ...vertex.body,
            {
              id: 2,
              type: BuiltinTypes.u32,
              op: { kind: 'constant', value: 7 },
              args: [],
            },
          ],
          outputs: [clipPosition, varying],
          results: { ...vertex.results, v_id: 2 },
        },
        { ...fragment, inputs: [clipPosition, varying] },
      ],
    });
    expect(sources.vertex).toContain('flat out uint v_id;');
    expect(sources.vertex).toContain('v_id = v2;');
    expect(sources.vertex).toContain(
      'gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;'
    );
    expect(sources.fragment).toContain('flat in uint v_id;');
  });

  it('avoids the identifiers reserved by GLSL', () => {
    const { fragment } = emit(
      fragmentModule([
        {
          id: 1,
          type: BuiltinTypes.vec4f,
          op: { kind: 'constant', value: [1, 1, 1, 1] },
          args: [],
          name: '__my__color',
        },
      ])
    );
    expect(fragment).toContain('vec4 v1_my_color = ');
    expect(fragment).not.toMatch(/__/);
  });

  it('generates a complete program', () => {
    const g = new GraphBuilder('textured-unlit');
    const uv = g.attribute('uv', BuiltinTypes.vec2f);
    const texel = g.call(std.textureSample, {
      texture: g.texture('diffuseMap'),
      sampler: g.sampler('diffuseSampler'),
      uv,
    });
    const color = g.call(
      std.mul,
      { a: texel, b: g.uniform('tint', BuiltinTypes.vec4f) },
      { label: 'color' }
    );
    g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
    const program = compile(g.build());
    const sources = emit(
      program.module,
      std140LayoutStrategy.resolve(program.layout)
    );
    expect(sources.vertex).toMatchSnapshot('vertex');
    expect(sources.fragment).toMatchSnapshot('fragment');
  });
});
