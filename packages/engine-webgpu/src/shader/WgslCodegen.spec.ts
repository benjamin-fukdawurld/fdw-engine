import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import {
  compile,
  GraphBuilder,
  IrEntryPoint,
  IrInstruction,
  ShaderModuleIR,
  std,
  stdLights,
  BuiltinTypes,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { WgslCodegen, wgslType } from './WgslCodegen';
import { wgslLayoutStrategy } from './wgslLayoutStrategy';

const codegen = new WgslCodegen();

const emit = (
  module: ShaderModuleIR,
  layout: PhysicalProgramLayout = { groups: [] }
) => {
  const sources = codegen.emit(module, layout);
  if (sources.kind !== 'single-module') {
    throw new Error('expected a single module');
  }
  return sources.code;
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

describe('wgslType', () => {
  it.each([
    [BuiltinTypes.f32, 'f32'],
    [BuiltinTypes.vec3u, 'vec3<u32>'],
    [BuiltinTypes.mat3f, 'mat3x3<f32>'],
    [BuiltinTypes.texture2d, 'texture_2d<f32>'],
    [BuiltinTypes.textureCube, 'texture_cube<f32>'],
    [BuiltinTypes.depthTexture2d, 'texture_depth_2d'],
    [
      { kind: 'texture', dimension: '2d', sampleType: 'uint' } as const,
      'texture_2d<u32>',
    ],
    [BuiltinTypes.comparisonSampler, 'sampler_comparison'],
  ])('%j → %s', (type, expected) => {
    expect(wgslType(type)).toBe(expected);
  });

  it('rejects types that are not supported yet', () => {
    expect(() =>
      wgslType({ kind: 'array', element: BuiltinTypes.f32 })
    ).toThrow(/not supported/);
  });
});

describe('WgslCodegen', () => {
  it('writes typed literals', () => {
    const code = emit(
      fragmentModule([
        {
          id: 1,
          type: BuiltinTypes.f32,
          op: { kind: 'constant', value: 1 },
          args: [],
        },
        {
          id: 2,
          type: BuiltinTypes.f32,
          op: { kind: 'constant', value: 1e-7 },
          args: [],
        },
        {
          id: 3,
          type: BuiltinTypes.i32,
          op: { kind: 'constant', value: -2 },
          args: [],
        },
        {
          id: 4,
          type: BuiltinTypes.u32,
          op: { kind: 'constant', value: 3 },
          args: [],
        },
        {
          id: 5,
          type: BuiltinTypes.bool,
          op: { kind: 'constant', value: true },
          args: [],
        },
        {
          id: 6,
          type: BuiltinTypes.vec4f,
          op: { kind: 'constant', value: [1, 0.5, 0, 1] },
          args: [],
        },
      ])
    );
    expect(code).toContain('let v1: f32 = 1.0;');
    expect(code).toContain('let v2: f32 = 1e-7;');
    expect(code).toContain('let v3: i32 = -2i;');
    expect(code).toContain('let v4: u32 = 3u;');
    expect(code).toContain('let v5: bool = true;');
    expect(code).toContain(
      'let v6: vec4<f32> = vec4<f32>(1.0, 0.5, 0.0, 1.0);'
    );
  });

  it('uses textures and samplers inline, as WGSL handles cannot be let-bound', () => {
    const layout: PhysicalProgramLayout = {
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
              resource: {
                kind: 'sampler',
                name: 'mapSampler',
                comparison: false,
              },
            },
          ],
        },
      ],
    };
    const code = emit(
      fragmentModule([
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
      ]),
      layout
    );
    expect(code).not.toMatch(/let v\d+: (texture|sampler)/);
    expect(code).toContain(
      'let v4_texel: vec4<f32> = textureSample(t_map, s_mapSampler, v3); // #n4'
    );
  });

  it('declares the builtins used by each stage', () => {
    const code = emit(
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
      ])
    );
    expect(code).toContain(
      'fn fs_main(in: Varyings, @builtin(front_facing) frontFacing: bool)'
    );
    expect(code).toContain('let v2: vec4<f32> = in.clipPosition;');
    expect(code).toContain('let v4: vec4<f32> = select(v3, v2, v1);');
  });

  it('uses flat interpolation for integer varyings', () => {
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
    const code = emit({
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
    expect(code).toContain('@location(0) @interpolate(flat) v_id: u32,');
    expect(code).toContain('out.v_id = v2;');
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
    const code = emit(
      program.module,
      wgslLayoutStrategy.resolve(program.layout)
    );
    expect(code).toContain('u_lightCount: u32,');
    expect(code).toContain('u_lightDiffuses: array<vec4<f32>, 16>,');
    expect(code).toMatch(
      /var (v\d+): vec3<f32> = vec3<f32>\(\);\n {2}for \(var (v\d+): u32 = 0u; \2 < v\d+; \2 = \2 \+ 1u\) \{/
    );
    // The light arrays are indexed in place, in the loop body.
    expect(code).toMatch(
      / {4}let v\d+: vec4<f32> = frameUniforms\.u_lightDiffuses\[v\d+\];/
    );
    expect(code).toMatch(/ {4}(v\d+) = \1 \+ v\d+;\n {2}\}/);
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
    const code = emit(
      program.module,
      wgslLayoutStrategy.resolve(program.layout)
    );
    expect(code).toMatchSnapshot();
  });
});
