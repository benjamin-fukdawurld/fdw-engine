import {
  PhysicalProgramLayout,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import {
  arrayType,
  BuiltinTypes,
  CompiledProgram,
  compile,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  compileDxil,
  compileHlsl,
  findTool,
  reflectUniformBlocks,
  validateSpirv,
} from '../tools/spirvTools';
import { HlslCodegen, hlslType } from './HlslCodegen';

const codegen = new HlslCodegen();
const d3d12 = new HlslCodegen({ target: 'd3d12' });

const emit = (program: CompiledProgram, generator = codegen) => {
  const layout = std140LayoutStrategy.resolve(program.layout);
  const sources = generator.emit(program.module, layout);
  if (sources.kind !== 'single-module') {
    throw new Error('expected a single module');
  }
  return { sources, code: sources.code, layout };
};

// --- Programs covering the IR -----------------------------------------------

const unlit = () => {
  const g = new GraphBuilder('unlit');
  const color = g.uniform('color', BuiltinTypes.vec4f, {
    default: [1, 0, 0, 1],
  });
  g.surface({ baseColor: color.swizzle('rgb'), alpha: color.swizzle('a') });
  return compile(g.build(), { vertexAttributes: ['position'] });
};

const texturedPhong = () => {
  const g = new GraphBuilder('textured phong');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  g.surface({
    shadingModel: 'phong',
    baseColor: g.call(std.mul, {
      a: texel.swizzle('rgb'),
      b: g.uniform('tint', BuiltinTypes.vec3f),
    }),
    shininess: g.uniform('shininess', BuiltinTypes.f32),
  });
  return compile(g.build(), {
    vertexAttributes: ['position', 'normal', 'uv'],
    features: { toneMapping: 'aces', outputEncoding: 'srgb' },
  });
};

const shadowedPbr = (features: Record<string, string | boolean> = {}) => {
  const g = new GraphBuilder('shadowed pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
    alpha: g.uniform('opacity', BuiltinTypes.f32),
  });
  return compile(g.build(), {
    vertexAttributes: ['position', 'normal'],
    features: { shadows: true, ...features },
  });
};

const toneMapping = () => {
  const g = new GraphBuilder('tone mapping');
  const texel = g.call(std.textureSample, {
    texture: g.texture('hdr'),
    sampler: g.sampler('hdrSampler'),
    uv: g.builtin('screen-uv'),
  });
  g.fullscreen({
    color: g.call(std.extend, {
      xyz: g.call('color.linearToSrgb', {
        color: g.call(std.mul, {
          a: texel.swizzle('rgb'),
          b: g.engine('exposure'),
        }),
      }),
      w: 1,
    }),
  });
  return compile(g.build());
};

// A full screen pass writing three color targets.
const threeTargets = () => {
  const g = new GraphBuilder('three targets');
  g.fullscreen({ color: [1, 0, 0, 1] });
  g.target('uv', g.builtin('screen-uv'), 1);
  g.target('id', g.constant(BuiltinTypes.u32, 7), 2);
  return compile(g.build());
};

// output[i] = input[i] × factor, for i < arrayLength(input).
const scaleKernel = () => {
  const g = new GraphBuilder('scale');
  const index = g.builtin('global-invocation-id').swizzle('x');
  const input = g.storage('input', arrayType(BuiltinTypes.f32));
  const output = g.storage('output', arrayType(BuiltinTypes.f32), {
    access: 'read-write',
  });
  const count = g.call(std.arrayLength, { array: input });
  const groups = g.builtin('num-workgroups').swizzle('x');
  g.compute({ workgroupSize: [64, 1, 1] });
  g.write(output, {
    index,
    value: g.call(std.add, {
      a: g.call(std.mul, {
        a: g.call(std.index, { array: input, index }),
        b: g.uniform('factor', BuiltinTypes.f32),
      }),
      b: g.call(
        std.convert,
        { value: groups },
        { params: { to: BuiltinTypes.f32 } },
      ),
    }),
    when: g.call(std.less, { a: index, b: count }),
  });
  return compile(g.build());
};

// Raw stages: integer varying, builtins, matrix constant.
const rawStages = () => {
  const g = new GraphBuilder('raw');
  const matrix = g.constant(
    BuiltinTypes.mat4f,
    [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 1, 2, 3, 1],
  );
  const position = g.call(std.extend, {
    xyz: g.attribute('position', BuiltinTypes.vec3f),
    w: 1,
  });
  g.node('output.vertex', {
    inputs: {
      clipPosition: g.call(std.transform, { matrix, vector: position }),
    },
  });
  // Read per fragment: an integer varying.
  const id = g.call(std.perFragment, { value: g.builtin('instance-index') });
  const palette = g.storage('palette', arrayType(BuiltinTypes.vec4f));
  const color = g.call(std.select, {
    ifFalse: g.call(std.index, { array: palette, index: id }),
    ifTrue: [1, 1, 1, 1],
    condition: g.builtin('front-facing'),
  });
  g.node('output.fragment', { inputs: { color } });
  return compile(g.build());
};

// A full screen pass reading texels by their coordinates: a float texture
// that cannot be filtered, at a level, and a depth texture.
const texelLoads = () => {
  const g = new GraphBuilder('texel loads');
  const coords = g.call(
    std.convert,
    { value: g.call(std.mul, { a: g.builtin('screen-uv'), b: [64, 32] }) },
    { params: { to: BuiltinTypes.vec2i } },
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
  return compile(g.build());
};

const programs: [string, () => CompiledProgram][] = [
  ['unlit', unlit],
  ['textured phong with tone mapping', texturedPhong],
  ['pbr with shadows', () => shadowedPbr()],
  [
    'masked pbr, depth only',
    () => shadowedPbr({ depthOnly: true, alphaMode: 'mask' }),
  ],
  ['full screen tone mapping', toneMapping],
  ['compute kernel', scaleKernel],
  ['raw stages', rawStages],
  ['three color targets', threeTargets],
  ['texel loads', texelLoads],
];

// --- Tests -------------------------------------------------------------------

describe('hlslType', () => {
  it('names the types as HLSL does', () => {
    expect(hlslType(BuiltinTypes.vec3f)).toBe('float3');
    expect(hlslType(BuiltinTypes.vec2u)).toBe('uint2');
    // Rows × columns in HLSL.
    expect(
      hlslType({ kind: 'matrix', columns: 4, rows: 3, scalar: 'f32' }),
    ).toBe('float3x4');
    expect(hlslType(BuiltinTypes.depthTexture2d)).toBe('Texture2D<float>');
    expect(hlslType(BuiltinTypes.comparisonSampler)).toBe(
      'SamplerComparisonState',
    );
    expect(() => hlslType(BuiltinTypes.f16)).toThrow(/not supported/);
  });
});

describe('HlslCodegen', () => {
  it('declares the resources with their descriptor sets, bindings and offsets', () => {
    const { code } = emit(texturedPhong());
    expect(code).toContain('#pragma pack_matrix(column_major)');
    expect(code).toContain('  [[vk::offset(0)]] float4x4 u_viewProjection;');
    expect(code).toContain(
      '  [[vk::offset(288)]] float4 u_lightPositions[16];',
    );
    expect(code).toContain(
      '[[vk::binding(0, 0)]] ConstantBuffer<FrameUniforms> frameUniforms;',
    );
    expect(code).toMatch(
      /\[\[vk::binding\(\d, 1\)\]\] Texture2D<float4> t_map;/,
    );
    expect(code).toMatch(
      /\[\[vk::binding\(\d, 1\)\]\] SamplerState s_mapSampler;/,
    );
  });

  it('multiplies by matrices with mul, and writes their constants by rows', () => {
    const { code } = emit(rawStages());
    // Column-major constant: the translation is the last column.
    expect(code).toContain(
      'float4x4(2.0, 0.0, 0.0, 1.0, 0.0, 3.0, 0.0, 2.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 0.0, 1.0)',
    );
    expect(code).toMatch(/= mul\(v\d+, v\d+\);/);
    expect(code).toMatch(/const float4 v\d+ = mul\(v1, v\d+\);/);
  });

  it('declares the builtins and the integer varyings of each stage', () => {
    const { code } = emit(rawStages());
    expect(code).toMatch(
      /ps_main\(Varyings input, bool frontFacing : SV_IsFrontFace\)/,
    );
    expect(code).toContain('StructuredBuffer<float4> b_palette;');
    // select(condition, ifTrue, ifFalse).
    expect(code).toMatch(
      /const bool (v\d+) = frontFacing;[\s\S]*select\(\1, v\d+, v\d+\)/,
    );
    expect(code).toMatch(
      /\[\[vk::location\(0\)\]\] nointerpolation uint v_\w+ : VARYING0;/,
    );
    expect(code).toMatch(/const float4 v\d+ = b_palette\[v\d+\];/);
    const fullscreen = emit(toneMapping()).code;
    expect(fullscreen).toContain(
      'Varyings vs_main(uint vertexIndex : SV_VertexID)',
    );
  });

  it('sums over the lights with a loop, and compares depths in it', () => {
    const { code } = emit(shadowedPbr());
    expect(code).toMatch(
      /float3 (v\d+) = \(float3\)0;\n {2}for \(uint (v\d+) = 0u; \2 < v\d+; \2 = \2 \+ 1u\) \{/,
    );
    expect(code).toContain('ConstantBuffer<FrameUniforms> frameUniforms;');
    expect(code).toContain('Texture2D<float> t_shadowMap;');
    expect(
      code.match(/t_shadowMap\.SampleCmpLevelZero\(s_shadowSampler, /g),
    ).toHaveLength(9);
    expect(code).toContain('float4x4 u_lightShadowMatrices[16];');
  });

  it('carries the state of a fold loop, and writes the integer operators', () => {
    const g = new GraphBuilder('folded hash');
    const seed = g.uniform('seed', BuiltinTypes.u32);
    const bits = g.fold(seed, g.uniform('rounds', BuiltinTypes.u32), (state) =>
      g.call(std.bitXor, {
        a: g.call(std.mul, { a: state, b: 747796405 }),
        b: g.call(std.shiftRight, { value: state, amount: 16 }),
      }),
    );
    const unit = g.call(
      std.convert,
      { value: g.call(std.bitAnd, { a: bits, b: 255 }) },
      { params: { to: BuiltinTypes.f32 } },
    );
    g.surface({ baseColor: g.call(std.vec3, { x: unit }) });
    const program = compile(g.build());
    const { code } = emit(program);
    expect(code).toMatch(
      /uint (v\d+) = v\w+;\n {2}for \(uint (v\d+) = 0u; \2 < v\w+; \2 = \2 \+ 1u\) \{/,
    );
    expect(code).toMatch(/\(v\d+ >> v\d+\)/);
    expect(code).toMatch(/ {4}(v\d+) = v\d+;\n {2}\}/);
  });

  it('writes no color in depth-only programs, and discards after the body', () => {
    const { code } = emit(shadowedPbr({ depthOnly: true, alphaMode: 'mask' }));
    expect(code).toMatch(
      /void ps_main\(Varyings input\) \{\n[\s\S]*discard;\n {2}\}\n\}/,
    );
    expect(code).not.toContain('SV_Target');
  });

  it('writes the compute stages, with their writes after the body', () => {
    const { code, sources } = emit(scaleKernel());
    expect(sources.entryPoints).toEqual({ compute: 'cs_main' });
    expect(code).toContain('[numthreads(64, 1, 1)]');
    expect(code).toContain(
      'void cs_main(uint3 globalInvocationId : SV_DispatchThreadID) {',
    );
    expect(code).toContain(
      '[[vk::ext_builtin_input(24)]] static const uint3 gl_NumWorkGroups;',
    );
    expect(code).toMatch(/b_input\.GetDimensions\(v\d+, v\d+_stride\);/);
    expect(code).toMatch(
      / {2}if \(v\d+\) \{\n {4}b_output\[v\d+\] = v\d+;\n {2}\}/,
    );
  });

  it('generates a complete program', () => {
    expect(emit(texturedPhong()).code).toMatchSnapshot();
  });
});

// The generated code compiled by DXC, validated by spirv-val, and its uniform
// blocks reflected by spirv-cross: when the Vulkan SDK is installed.
const sdk = !!(
  findTool('dxc') &&
  findTool('spirv-val') &&
  findTool('spirv-cross')
);

// The offsets of the uniform blocks of a module are those of the layout.
async function expectLayout(
  spirv: Uint8Array,
  layout: PhysicalProgramLayout,
): Promise<void> {
  const reflected = await reflectUniformBlocks(spirv);
  for (const group of layout.groups) {
    for (const { binding, block, resource } of group.bindings) {
      const found = [...reflected.values()].find(
        (candidate) =>
          candidate.set === group.index && candidate.binding === binding,
      );
      // Only the blocks the stage uses are in its module.
      if (!block || !found) {
        continue;
      }
      expect(
        found.members.map((member) => member.offset),
        resource.name,
      ).toEqual(block.members.map((member) => member.offset));
      expect(found.size, resource.name).toBeLessThanOrEqual(block.size);
    }
  }
}

describe('HlslCodegen color targets', () => {
  it('returns the color targets in a structure', () => {
    const { code } = emit(threeTargets());
    expect(code).toContain(
      [
        'struct FragmentOutputs {',
        '  float4 o_color : SV_Target0;',
        '  float2 o_uv : SV_Target1;',
        '  uint o_id : SV_Target2;',
        '};',
      ].join('\n'),
    );
    expect(code).toMatch(/FragmentOutputs ps_main\(/);
    expect(code).toMatch(/targets\.o_id = v\d+;\n {2}return targets;\n\}/);
  });
});

describe('HlslCodegen texel loads', () => {
  it('reads texels with Load, the level as the last coordinate', () => {
    const { code } = emit(texelLoads());
    expect(code).toContain('Texture2D<float4> t_values');
    expect(code).toContain('Texture2D<float> t_depth');
    expect(code).toMatch(/float4 v\d+ = t_values\.Load\(int3\(v\d+, v\d+\)\)/);
    expect(code).toMatch(/float v\d+ = t_depth\.Load\(int3\(v\d+, v\d+\)\)/);
  });
});

describe.skipIf(!sdk)('HlslCodegen with DXC', () => {
  for (const [name, program] of programs) {
    it(`compiles ${name} to valid SPIR-V with the offsets of the layout`, async () => {
      const { sources, layout } = emit(program());
      const modules = await compileHlsl(sources);
      expect([...modules.keys()]).toEqual(Object.keys(sources.entryPoints));
      for (const spirv of modules.values()) {
        await validateSpirv(spirv);
        await expectLayout(spirv, layout);
      }
    });
  }
});

describe('HlslCodegen for the ray tracing pipelines', () => {
  // hits[i]: a ray up from (i, 0, 0), with alpha test.
  const tracing = () => {
    const g = new GraphBuilder('trace');
    const index = g.builtin('global-invocation-id').swizzle('x');
    const hits = g.storage('hits', arrayType(BuiltinTypes.vec4u), {
      access: 'read-write',
    });
    const x = g.call(std.convert, { value: index }, { params: { to: BuiltinTypes.f32 } });
    const hit = g.traceRay({
      origin: g.call(std.vec3, { x, y: 0, z: 0 }),
      direction: [0, 1, 0],
      mode: 'any',
      alphaTest: true,
    });
    g.write(hits, { index, value: hit });
    g.compute();
    return compile(g.build(), { capabilities: { rayQuery: true } });
  };

  it('writes a ray generation shader, its rays traced by TraceRay', () => {
    const program = tracing();
    const layout = std140LayoutStrategy.resolve(program.layout);
    const sources = codegen.emit(program.module, layout, { rayGeneration: true });
    if (sources.kind !== 'single-module') {
      throw new Error('expected a single module');
    }
    expect(sources.entryPoints).toEqual({ compute: 'rg_main' });
    const { code } = sources;
    expect(code).toContain('[shader("raygeneration")]');
    expect(code).toContain('const uint3 globalInvocationId = DispatchRaysIndex();');
    expect(code).toMatch(/TraceRay\(as_scene, RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH, mask & 0xffu, 0, 1, 0, ray, payload\);/);
    expect(code).not.toContain('RayQuery<');
    // The shaders of the hits: the miss, the closest hit, the alpha test.
    expect(code).toContain('[shader("miss")]');
    expect(code).toContain('[shader("closesthit")]');
    expect(code).toMatch(/\[shader\("anyhit"\)\][^]*fdw_kept_as_scene\(InstanceIndex\(\), PrimitiveIndex\(\), attributes.barycentrics\)[^]*IgnoreHit\(\);/);
    // As a compute shader: the ray queries.
    const compute = emit(program).code;
    expect(compute).toContain('RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH>');
    expect(compute).not.toContain('[shader(');
  });
});

describe('HlslCodegen for Direct3D 12', () => {
  it('binds the resources to registers, the group as the space', () => {
    const { code } = emit(texturedPhong(), d3d12);
    expect(code).not.toContain('vk::');
    expect(code).toContain('Texture2D<float4> t_map : register(t');
    expect(code).toContain('SamplerState s_mapSampler : register(s');
    expect(code).toMatch(
      /cbuffer cb_materialUniforms : register\(b\d+, space\d+\)/,
    );
    expect(code).toMatch(
      /float3 materialUniforms_u_tint : packoffset\(c\d+(\.[yzw])?\);/,
    );
  });

  it('adds the first instance of the draw, and reads the workgroups from constants', () => {
    const raw = emit(rawStages(), d3d12).code;
    expect(raw).toContain('cbuffer FdwDraw : register(b0, space100)');
    expect(raw).toContain('(instanceIndex + fdw_firstInstance)');
    const kernel = emit(scaleKernel(), d3d12).code;
    expect(kernel).toContain('cbuffer FdwDispatch : register(b0, space100)');
    expect(kernel).toContain('RWStructuredBuffer<float> b_output : register(u');
  });
});

// The offsets of the members of a cbuffer, in the disassembly of DXC.
const dxilOffset = (disassembly: string, member: string) =>
  Number(
    new RegExp(`\\b${member};\\s*; Offset:\\s*(\\d+)`).exec(disassembly)?.[1],
  );

describe.skipIf(!sdk)('HlslCodegen for Direct3D 12 with DXC', () => {
  for (const [name, program] of programs) {
    it(`compiles ${name} to DXIL with the offsets of the layout`, async () => {
      const { sources, layout } = emit(program(), d3d12);
      const modules = await compileDxil(sources);
      expect([...modules.keys()]).toEqual(Object.keys(sources.entryPoints));
      const disassembly = [...modules.values()].join('\n');
      for (const group of layout.groups) {
        for (const { resource, block } of group.bindings) {
          for (const member of block?.members ?? []) {
            const identifier = `${resource.name}_u_${member.name}`;
            if (disassembly.includes(`${identifier};`)) {
              expect(dxilOffset(disassembly, identifier), identifier).toBe(
                member.offset,
              );
            }
          }
        }
      }
    });
  }
});
