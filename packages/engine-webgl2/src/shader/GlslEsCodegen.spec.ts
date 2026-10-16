import {
  PhysicalProgramLayout,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import {
  BuiltinTypes,
  compile,
  GraphBuilder,
  IrEntryPoint,
  IrInstruction,
  ShaderModuleIR,
  std,
  stdLights,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { combinedSamplers } from './combinedSamplers';
import { GlslEsCodegen, glslSamplerType, glslType } from './GlslEsCodegen';

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
  it('compares depths with shadow samplers, at level 0', () => {
    const g = new GraphBuilder('lit');
    g.surface({
      shadingModel: 'phong',
      baseColor: [1, 1, 1],
      alpha: g.uniform('opacity', BuiltinTypes.f32),
    });
    const graph = g.build();
    const options = { vertexAttributes: ['position', 'normal'] };
    const program = compile(graph, { ...options, features: { shadows: true } });
    const layout = std140LayoutStrategy.resolve(program.layout);
    expect(combinedSamplers(program.module, layout)).toEqual([
      {
        name: 'ts0_shadowMap_shadowSampler',
        texture: 'shadowMap',
        sampler: 'shadowSampler',
        type: BuiltinTypes.depthTexture2d,
        comparison: true,
      },
    ]);
    const { fragment } = emit(program.module, layout);
    expect(fragment).toContain('precision highp sampler2DShadow;');
    expect(fragment).toContain(
      'uniform sampler2DShadow ts0_shadowMap_shadowSampler;'
    );
    // The reference depth after the uv, whose v is flipped as for every 2d
    // texture.
    expect(fragment).toMatch(
      /textureLod\(ts0_shadowMap_shadowSampler, vec3\(vec2\((v\d+)\.x, ts0_shadowMap_shadowSampler_v\.x \+ ts0_shadowMap_shadowSampler_v\.y \* \1\.y\), v\d+\), 0\.0\)/
    );
    expect(glslSamplerType(BuiltinTypes.depthTexture2d, true)).toBe(
      'sampler2DShadow'
    );
  });

  it('writes no color in depth-only programs', () => {
    const g = new GraphBuilder('lit');
    g.surface({
      shadingModel: 'phong',
      baseColor: [1, 1, 1],
      alpha: g.uniform('opacity', BuiltinTypes.f32),
    });
    const graph = g.build();
    const options = { vertexAttributes: ['position', 'normal'] };
    const program = compile(graph, {
      ...options,
      features: { depthOnly: true },
    });
    const { fragment } = emit(
      program.module,
      std140LayoutStrategy.resolve(program.layout)
    );
    expect(fragment).not.toContain(' out ');
    expect(fragment).toMatch(/void main\(\) \{\n\}/);
  });

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
        comparison: false,
      },
    ]);
    const { vertex, fragment } = emit(module, textureLayout);
    expect(fragment).toContain('precision highp sampler2D;');
    expect(fragment).toContain('uniform sampler2D ts0_map_mapSampler;');
    expect(fragment).toContain(
      'vec4 v4_texel = texture(ts0_map_mapSampler, vec2(v3.x, ts0_map_mapSampler_v.x + ts0_map_mapSampler_v.y * v3.y)); // #n4'
    );
    // The orientation of the texture: v read as a + b × v.
    expect(fragment).toContain('uniform vec2 ts0_map_mapSampler_v;');
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

  it('sums over the lights with a loop', () => {
    const g = new GraphBuilder('diffuse-lights');
    const light = g.node(stdLights.current);
    g.surface({
      baseColor: g.call(stdLights.sum, {
        value: g.call(std.mul, {
          a: light.diffuse,
          b: g.uniform('tint', BuiltinTypes.vec3f),
        }),
      }),
    });
    const program = compile(g.build());
    const { fragment } = emit(
      program.module,
      std140LayoutStrategy.resolve(program.layout)
    );
    expect(fragment).toContain('uint u_lightCount;');
    expect(fragment).toContain('vec4 u_lightDiffuses[16];');
    expect(fragment).toMatch(
      /vec3 (v\d+) = vec3\(0\.0\);\n {2}for \(uint (v\d+) = 0u; \2 < v\d+; \2\+\+\) \{/
    );
    expect(fragment).toMatch(
      / {4}vec4 v\d+ = frameUniforms\.u_lightDiffuses\[v\d+\];/
    );
    expect(fragment).toMatch(/ {4}v\d+ \+= v\d+;\n {2}\}/);
  });

  it('discards after the whole body, before writing the color', () => {
    const g = new GraphBuilder('masked');
    const texel = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv: g.attribute('uv', BuiltinTypes.vec2f),
    });
    g.surface({ baseColor: texel.swizzle('rgb'), alpha: texel.swizzle('a') });
    const program = compile(g.build(), { features: { alphaMode: 'mask' } });
    const { fragment } = emit(
      program.module,
      std140LayoutStrategy.resolve(program.layout)
    );
    expect(fragment).toMatch(
      /bool (v\d+) = v\d+ < v\d+;[\s\S]*\n {2}if \(\1\) \{\n {4}discard;\n {2}\}\n {2}o_color = v\d+;\n\}/
    );
    expect(fragment.indexOf('texture(')).toBeLessThan(
      fragment.indexOf('discard')
    );
  });

  it('compares vectors with functions', () => {
    const { fragment } = emit(
      fragmentModule([
        {
          id: 1,
          type: BuiltinTypes.vec3f,
          op: { kind: 'constant', value: [0, 1, 2] },
          args: [],
        },
        {
          id: 2,
          type: { kind: 'vector', size: 3, scalar: 'bool' },
          op: { kind: 'compare', operator: '<=' },
          args: [1, 1],
        },
        {
          id: 3,
          type: BuiltinTypes.f32,
          op: { kind: 'swizzle', components: 'x' },
          args: [1],
        },
        {
          id: 4,
          type: BuiltinTypes.bool,
          op: { kind: 'compare', operator: '!=' },
          args: [3, 3],
        },
        {
          id: 5,
          type: BuiltinTypes.vec4f,
          op: { kind: 'constant', value: [1, 1, 1, 1] },
          args: [],
        },
      ])
    );
    expect(fragment).toContain('bvec3 v2 = lessThanEqual(v1, v1);');
    expect(fragment).toContain('bool v4 = v3 != v3;');
  });

  it('declares an out variable per color target', () => {
    const g = new GraphBuilder('three targets');
    g.fullscreen({ color: [1, 0, 0, 1] });
    g.target('uv', g.builtin('screen-uv'), 1);
    g.target('id', g.constant(BuiltinTypes.u32, 7), 2);
    const program = compile(g.build());
    const { fragment } = emit(
      program.module,
      std140LayoutStrategy.resolve(program.layout)
    );
    expect(fragment).toContain(
      [
        'layout(location = 0) out vec4 o_color;',
        'layout(location = 1) out vec2 o_uv;',
        'layout(location = 2) out uint o_id;',
      ].join('\n')
    );
    expect(fragment).toMatch(/ {2}o_id = v\d+;\n\}/);
  });

  it('reads texels with texelFetch, rows counted from the top', () => {
    const g = new GraphBuilder('texel loads');
    const coords = g.call(
      std.convert,
      { value: g.call(std.mul, { a: g.builtin('screen-uv'), b: [64, 32] }) },
      { params: { to: BuiltinTypes.vec2i } }
    );
    const texel = g.call(std.textureLoad, {
      texture: g.texture('values', { sampleType: 'unfilterable-float' }),
      coords,
      level: 1,
    });
    const depth = g.call(std.textureLoadDepth, {
      texture: g.texture('depth', { sampleType: 'depth' }),
      coords,
    });
    g.fullscreen({ color: g.call(std.mul, { a: texel, b: depth }) });
    const program = compile(g.build());
    const layout = std140LayoutStrategy.resolve(program.layout);
    // A combined sampler without sampler per texture.
    expect(
      combinedSamplers(program.module, layout).map(
        ({ name, texture, sampler, comparison }) => ({
          name,
          texture,
          sampler,
          comparison,
        })
      )
    ).toEqual([
      {
        name: 'ts0_values_load',
        texture: 'values',
        sampler: undefined,
        comparison: false,
      },
      {
        name: 'ts1_depth_load',
        texture: 'depth',
        sampler: undefined,
        comparison: false,
      },
    ]);
    const { fragment } = emit(program.module, layout);
    expect(fragment).toContain('uniform sampler2D ts1_depth_load;');
    expect(fragment).toMatch(
      /vec4 v\d+ = texelFetch\(ts0_values_load, ivec2\((v\d+)\.x, int\(ts0_values_load_v\.x\) \* \(textureSize\(ts0_values_load, (v\d+)\)\.y - 1\) \+ int\(ts0_values_load_v\.y\) \* \1\.y\), \2\);/
    );
    expect(fragment).toMatch(
      /float v\d+ = texelFetch\(ts1_depth_load, ivec2\(v\d+\.x, int\(ts1_depth_load_v\.x\) \* \(textureSize\(ts1_depth_load, v\d+\)\.y - 1\) \+ int\(ts1_depth_load_v\.y\) \* v\d+\.y\), v\d+\)\.r;/
    );
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
