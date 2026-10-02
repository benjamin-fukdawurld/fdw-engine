import type { PhysicalProgramLayout } from '@fdw/engine-backend';
import {
  compile,
  GraphBuilder,
  IrEntryPoint,
  IrInstruction,
  ShaderModuleIR,
  std,
  T,
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
  type: T.vec4f,
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
        type: T.vec4f,
        op: { kind: 'constant', value: [0, 0, 0, 1] },
        args: [],
      },
    ],
    results: { clipPosition: 1 },
  };
  const fragment: IrEntryPoint = {
    stage: 'fragment',
    inputs: [clipPosition],
    outputs: [{ name: 'color', type: T.vec4f, location: 0 }],
    body,
    results: { color: result },
  };
  return { name: 'test', entryPoints: [vertex, fragment] };
};

describe('wgslType', () => {
  it.each([
    [T.f32, 'f32'],
    [T.vec3u, 'vec3<u32>'],
    [T.mat3f, 'mat3x3<f32>'],
    [T.texture2d, 'texture_2d<f32>'],
    [T.textureCube, 'texture_cube<f32>'],
    [T.depthTexture2d, 'texture_depth_2d'],
    [
      { kind: 'texture', dimension: '2d', sampleType: 'uint' } as const,
      'texture_2d<u32>',
    ],
    [T.comparisonSampler, 'sampler_comparison'],
  ])('%j → %s', (type, expected) => {
    expect(wgslType(type)).toBe(expected);
  });

  it('rejects types that are not supported yet', () => {
    expect(() =>
      wgslType({ kind: 'array', element: T.f32, length: 4 })
    ).toThrow(/not supported/);
  });
});

describe('WgslCodegen', () => {
  it('writes typed literals', () => {
    const code = emit(
      fragmentModule([
        { id: 1, type: T.f32, op: { kind: 'constant', value: 1 }, args: [] },
        { id: 2, type: T.f32, op: { kind: 'constant', value: 1e-7 }, args: [] },
        { id: 3, type: T.i32, op: { kind: 'constant', value: -2 }, args: [] },
        { id: 4, type: T.u32, op: { kind: 'constant', value: 3 }, args: [] },
        {
          id: 5,
          type: T.bool,
          op: { kind: 'constant', value: true },
          args: [],
        },
        {
          id: 6,
          type: T.vec4f,
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
              resource: { kind: 'texture', name: 'map', type: T.texture2d },
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
          type: T.texture2d,
          op: { kind: 'load-resource', binding: 'map' },
          args: [],
        },
        {
          id: 2,
          type: T.sampler,
          op: { kind: 'load-resource', binding: 'mapSampler' },
          args: [],
        },
        {
          id: 3,
          type: T.vec2f,
          op: { kind: 'constant', value: [0.5, 0.5] },
          args: [],
        },
        {
          id: 4,
          type: T.vec4f,
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
          type: T.bool,
          op: { kind: 'load-builtin', builtin: 'front-facing' },
          args: [],
        },
        {
          id: 2,
          type: T.vec4f,
          op: { kind: 'load-builtin', builtin: 'frag-coord' },
          args: [],
        },
        {
          id: 3,
          type: T.vec4f,
          op: { kind: 'constant', value: [0, 0, 0, 0] },
          args: [],
        },
        { id: 4, type: T.vec4f, op: { kind: 'select' }, args: [3, 2, 1] },
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
        type: T.vec4f,
        op: { kind: 'constant', value: [1, 1, 1, 1] },
        args: [],
      },
    ]);
    const varying = {
      name: 'v_id',
      type: T.u32,
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
              type: T.u32,
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

  it('generates a complete program', () => {
    const g = new GraphBuilder('textured-unlit');
    const uv = g.attribute('uv', T.vec2f);
    const texel = g.call(std.textureSample, {
      texture: g.texture('diffuseMap'),
      sampler: g.sampler('diffuseSampler'),
      uv,
    });
    const color = g.call(
      std.mul,
      { a: texel, b: g.uniform('tint', T.vec4f) },
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
