import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std, stdMacros, stdRays } from '../std';
import { arrayType, BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction } from './ir';

const rays = { capabilities: { rayQuery: true } } as const;

// hits[i] = the hit of the ray i (origins and directions in buffers).
function traceGraph(mode: 'closest' | 'any' = 'closest') {
  const g = new GraphBuilder('trace');
  const index = g.builtin('global-invocation-id').swizzle('x');
  const origins = g.storage('origins', arrayType(BuiltinTypes.vec4f));
  const directions = g.storage('directions', arrayType(BuiltinTypes.vec4f));
  const hits = g.storage('hits', arrayType(BuiltinTypes.vec4u), {
    access: 'read-write',
  });
  const hit = g.traceRay({
    origin: g.call(std.index, { array: origins, index }).swizzle('xyz'),
    direction: g.call(std.index, { array: directions, index }).swizzle('xyz'),
    tMax: 100,
    mode,
  });
  g.write(hits, { index, value: hit });
  g.compute();
  return g;
}

const instructions = (entry: IrEntryPoint) => {
  const all: IrInstruction[] = [];
  forEachInstruction(entry.body, (instruction) => all.push(instruction));
  return all;
};

describe('ray.trace', () => {
  it('compiles to a ray query of the scene of the frame', () => {
    const program = compile(traceGraph().build(), rays);
    const [compute] = program.module.entryPoints;
    const query = instructions(compute).find(
      (instruction) => instruction.op.kind === 'ray-query',
    );
    expect(query?.op).toEqual({ kind: 'ray-query', mode: 'closest' });
    expect(query?.type).toEqual(BuiltinTypes.vec4u);
    expect(query?.args).toHaveLength(6);
    const frame = program.layout.groups.find((group) => group.slot === 'frame');
    expect(frame?.bindings.map((binding) => binding.kind)).toEqual([
      'uniform-block',
      'acceleration-structure',
    ]);
    const any = compile(traceGraph('any').build(), rays);
    expect(
      instructions(any.module.entryPoints[0]).some(
        (instruction) =>
          instruction.op.kind === 'ray-query' && instruction.op.mode === 'any',
      ),
    ).toBe(true);
  });

  it('needs the rayQuery capability', () => {
    expect(() => compile(traceGraph().build())).toThrow(GraphError);
    expect(() => compile(traceGraph().build())).toThrow(/rayQuery/);
  });

  it('reads the hits from the buffers of the traced scene', () => {
    const g = new GraphBuilder('hits');
    const index = g.builtin('global-invocation-id').swizzle('x');
    const hits = g.storage('hits', arrayType(BuiltinTypes.vec4u));
    const out = g.storage('out', arrayType(BuiltinTypes.vec4f), {
      access: 'read-write',
    });
    const hit = g.call(std.index, { array: hits, index });
    const position = g.call(stdRays.hitPosition, { hit });
    const uv = g.call(stdRays.hitUv, { hit });
    g.write(out, {
      index,
      value: g.call(std.extend, {
        xyz: g.call(std.add, {
          a: position,
          b: g.call(stdRays.hitNormal, { hit }),
        }),
        w: uv.swizzle('x'),
      }),
      when: g.call(stdRays.hit, { hit }),
    });
    g.compute();
    // No ray traced: no capability needed.
    const program = compile(g.build());
    const frame = program.layout.groups.find((group) => group.slot === 'frame');
    expect(frame?.bindings.map((binding) => binding.name)).toEqual([
      'frameUniforms',
      'rayInstances',
      'rayGeometry',
    ]);
    expect(
      instructions(program.module.entryPoints[0]).filter(
        (instruction) => instruction.op.kind === 'bitcast',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('checks the sizes of bitcasts', () => {
    const g = new GraphBuilder('bits');
    const out = g.storage('out', arrayType(BuiltinTypes.u32), {
      access: 'read-write',
    });
    g.write(out, {
      index: 0,
      value: g.call(
        std.bitcast,
        { value: g.uniform('x', BuiltinTypes.vec2f) },
        { params: { to: BuiltinTypes.u32 } },
      ),
    });
    g.compute();
    expect(() => compile(g.build())).toThrow(/bitcast/);
  });
});

describe('the guard of compute graphs', () => {
  it('computes the guard first, and skips the rest', () => {
    const g = new GraphBuilder('guarded');
    const index = g.builtin('global-invocation-id').swizzle('x');
    const input = g.storage('input', arrayType(BuiltinTypes.f32));
    const output = g.storage('output', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    const value = g.call(std.index, { array: input, index });
    g.write(output, {
      index,
      value: g.call(std.sqrt, { x: g.call(std.mul, { a: value, b: 3 }) }),
    });
    g.compute({
      active: g.call(std.less, { a: index, b: g.uniform('count', BuiltinTypes.u32) }),
    });
    const [compute] = compile(g.build()).module.entryPoints;
    const active = compute.active;
    expect(active).toBeDefined();
    const before = compute.body.slice(0, active?.after);
    // The guard and what it needs, nothing else.
    expect(before.some((instruction) => instruction.id === active?.value)).toBe(
      true,
    );
    expect(
      before.some(
        (instruction) =>
          instruction.op.kind === 'intrinsic' && instruction.op.name === 'sqrt',
      ),
    ).toBe(false);
    expect(compute.body.length).toBeGreaterThan(active?.after ?? 0);
  });
});

describe('shadows by rays', () => {
  const material = () => {
    const g = new GraphBuilder('lit');
    g.surface({ shadingModel: 'pbr', baseColor: [1, 1, 1] });
    return g.build();
  };
  const queries = (program: ReturnType<typeof compile>) =>
    instructions(
      program.module.entryPoints.find(
        (entry) => entry.stage === 'fragment',
      ) as IrEntryPoint,
    ).filter((instruction) => instruction.op.kind === 'ray-query');

  it('trace a ray per light in the fragment stage', () => {
    const program = compile(material(), {
      ...rays,
      features: { rayShadows: true },
    });
    const traced = queries(program);
    expect(traced).toHaveLength(1);
    expect(traced[0].op).toEqual({
      kind: 'ray-query',
      mode: 'any',
      alphaTest: true,
    });
    expect(program.variantKey['rayShadows']).toBe(true);
    // Without the feature, no ray.
    expect(queries(compile(material(), rays))).toHaveLength(0);
  });

  it('average several rays for soft shadows', () => {
    const program = compile(material(), {
      ...rays,
      features: { rayShadows: true, rayShadowSamples: 4 },
    });
    expect(queries(program)).toHaveLength(4);
  });
});

describe('the hit target', () => {
  const textured = () => {
    const g = new GraphBuilder('textured');
    const uv = g.attribute('uv', BuiltinTypes.vec2f);
    const texel = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv,
    });
    g.surface({
      shadingModel: 'pbr',
      baseColor: g.call(std.mul, {
        a: texel.swizzle('rgb'),
        b: g.uniform('tint', BuiltinTypes.vec3f),
      }),
      roughness: g.call(std.fwidth, { x: uv.swizzle('x') }),
      metallic: 0.5,
    });
    return g.build();
  };

  it('compiles the surface of a material to the shading of the hits', () => {
    const program = compile(textured(), { target: 'hit' });
    const [compute] = program.module.entryPoints;
    expect(program.module.entryPoints).toHaveLength(1);
    expect(compute.stage).toBe('compute');
    expect(compute.writes).toHaveLength(5);
    expect(compute.writes?.every((write) => write.resource === 'raySurfaces')).toBe(true);
    expect(compute.active).toBeDefined();
    const ops = instructions(compute).map((instruction) => instruction.op.kind);
    expect(ops).toContain('sample-level');
    expect(ops).not.toContain('sample');
    expect(program.variantKey['target']).toBe('hit');
    const slots = Object.fromEntries(
      program.layout.groups.map((group) => [
        group.slot,
        group.bindings.map((binding) => binding.name),
      ]),
    );
    expect(slots['rays']).toEqual(['raysUniforms', 'rayHits', 'raySurfaces']);
    expect(slots['material']).toEqual(['materialUniforms', 'map', 'mapSampler']);
    expect(slots['frame']).toEqual([
      'frameUniforms',
      'rayInstances',
      'rayGeometry',
    ]);
  });

  it('reads the tangents of the hits for the normal maps, and the cutoff of the masked materials', () => {
    const g = new GraphBuilder('bumpy');
    const normal = g.call(std.textureSample, {
      texture: g.texture('normalMap'),
      sampler: g.sampler('normalSampler'),
      uv: g.attribute('uv', BuiltinTypes.vec2f),
    });
    g.surface({
      shadingModel: 'phong',
      normal: g.node(stdMacros.normalMapping, { inputs: { sample: normal.swizzle('xyz') } })['normal'],
    });
    const program = compile(g.build(), {
      target: 'hit',
      features: { alphaMode: 'mask' },
    });
    const material = program.layout.groups.find((group) => group.slot === 'material');
    const block = material?.bindings[0];
    expect(block?.kind === 'uniform-block' && block.members.map((m) => m.name)).toContain(
      'alphaCutoff',
    );
  });

  it('refuses what has no value at a hit', () => {
    const g = new GraphBuilder('instanced');
    g.surface({
      baseColor: g.call(std.vec3, {
        x: g.call(std.convert, { value: g.builtin('vertex-index') }, { params: { to: BuiltinTypes.f32 } }),
      }),
    });
    expect(() => compile(g.build(), { target: 'hit' })).toThrow(/vertex-index/);
  });

  it('reads the attributes computed in the vertex stage from the traced geometry', () => {
    // Positions made from the vertex index (a terrain of patches): the hit
    // program reads those of the geometry traced instead.
    const g = new GraphBuilder('generated');
    const index = g.call(std.convert, { value: g.builtin('vertex-index') }, { params: { to: BuiltinTypes.f32 } });
    g.vertexAttribute('position', g.call(std.vec3, { x: index, y: 0, z: 0 }));
    g.vertexAttribute('uv', g.call(std.vec2, { x: index, y: 1 }));
    g.surface({
      baseColor: g.call(std.vec3, {
        x: g.attribute('uv', BuiltinTypes.vec2f).swizzle('x'),
      }),
    });
    const program = compile(g.build(), { target: 'hit' });
    const instructions = program.module.entryPoints[0].body;
    expect(
      instructions.some(
        (instruction) =>
          instruction.op.kind === 'load-builtin' && instruction.op.builtin === 'vertex-index',
      ),
    ).toBe(false);
    expect(program.layout.groups.flatMap((group) => group.bindings.map((b) => b.name))).toContain(
      'rayGeometry',
    );
  });
});
