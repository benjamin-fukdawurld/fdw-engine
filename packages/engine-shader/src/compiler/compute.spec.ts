import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { arrayType, BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint } from './ir';

// output[i] = input[i] × factor, for i < arrayLength(input).
const scaleGraph = () => {
  const g = new GraphBuilder('scale');
  const index = g.builtin('global-invocation-id').swizzle('x');
  const input = g.storage('input', arrayType(BuiltinTypes.f32));
  const output = g.storage('output', arrayType(BuiltinTypes.f32), {
    access: 'read-write',
  });
  g.write(output, {
    index,
    value: g.call(std.mul, {
      a: g.call(std.index, { array: input, index }),
      b: g.uniform('factor', BuiltinTypes.f32),
    }),
    when: g.call(std.less, {
      a: index,
      b: g.call(std.arrayLength, { array: input }),
    }),
  });
  g.compute({ workgroupSize: [64, 1, 1] });
  return g;
};

const computeOf = (program: ReturnType<typeof compile>) =>
  program.module.entryPoints[0] as IrEntryPoint;

describe('compute graphs', () => {
  it('compile to a single compute stage with its writes', () => {
    const program = compile(scaleGraph().build());
    expect(program.module.entryPoints).toHaveLength(1);
    const compute = computeOf(program);
    expect(compute.stage).toBe('compute');
    expect(compute.workgroupSize).toEqual([64, 1, 1]);
    expect(compute.writes).toHaveLength(1);
    const [write] = compute.writes ?? [];
    expect(write.resource).toBe('output');
    const byId = (id: number | undefined) =>
      compute.body.find((instruction) => instruction.id === id);
    expect(byId(write.value)?.op).toEqual({ kind: 'binary', operator: '*' });
    expect(byId(write.condition)?.op).toEqual({
      kind: 'compare',
      operator: '<',
    });
    expect(program.vertexInputs).toEqual([]);
  });

  it('only have the slots they use', () => {
    const program = compile(scaleGraph().build());
    expect(program.layout.groups.map((group) => group.slot)).toEqual([
      'material',
    ]);
    expect(
      program.layout.groups[0].bindings.map((binding) => [
        binding.kind,
        binding.name,
      ]),
    ).toEqual([
      ['uniform-block', 'materialUniforms'],
      ['storage-buffer', 'input'],
      ['storage-buffer', 'output'],
    ]);

    // An engine value brings its slot.
    const g = new GraphBuilder('timed');
    const output = g.storage('output', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    g.write(output, { index: 0, value: g.engine('time') });
    g.compute();
    expect(compile(g.build()).layout.groups.map((group) => group.slot)).toEqual(
      ['frame', 'material'],
    );
  });

  it('sample textures at an explicit level', () => {
    const g = new GraphBuilder('sampled');
    const output = g.storage('output', arrayType(BuiltinTypes.vec4f), {
      access: 'read-write',
    });
    g.write(output, {
      index: 0,
      value: g.call(std.textureSampleLevel, {
        texture: g.texture('map'),
        sampler: g.sampler('mapSampler'),
        uv: [0.5, 0.5],
      }),
    });
    g.compute();
    const compute = computeOf(compile(g.build()));
    expect(compute.body.some((i) => i.op.kind === 'sample-level')).toBe(true);
  });

  it('reject the nodes of the other stages', () => {
    const g = new GraphBuilder('sampled');
    const output = g.storage('output', arrayType(BuiltinTypes.vec4f), {
      access: 'read-write',
    });
    g.write(output, {
      index: 0,
      value: g.call(std.textureSample, {
        texture: g.texture('map'),
        sampler: g.sampler('mapSampler'),
        uv: [0.5, 0.5],
      }),
    });
    g.compute();
    expect(() => compile(g.build())).toThrow(
      /std.textureSample is only available in the fragment stage: use std.textureSampleLevel/,
    );
  });

  it('do not read the buffers they write', () => {
    const g = new GraphBuilder('feedback');
    const values = g.storage('values', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    g.write(values, {
      index: 0,
      value: g.call(std.index, { array: values, index: 1 }),
    });
    g.compute();
    expect(() => compile(g.build())).toThrow(
      /"values" is written by the graph: it cannot be read/,
    );
  });

  it('do not write read-only buffers', () => {
    const g = new GraphBuilder('read-only');
    const values = g.storage('values', arrayType(BuiltinTypes.f32));
    g.write(values, { index: 0, value: 1 });
    g.compute();
    expect(() => compile(g.build())).toThrow(/"values" is read-only/);
  });

  it('check their outputs and workgroup size', () => {
    const noOutput = new GraphBuilder('no-output');
    const values = noOutput.storage('values', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    noOutput.write(values, { index: 0, value: 1 });
    expect(() => noOutput.build()).toThrow(/add an output.compute node/);

    const mixed = scaleGraph();
    expect(() => mixed.surface()).toThrow(/already has an output/);

    const size = new GraphBuilder('size');
    const out = size.storage('values', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    size.write(out, { index: 0, value: 1 });
    size.compute({ workgroupSize: [0, 1, 1] });
    expect(() => compile(size.build())).toThrow(
      /workgroupSize must be three positive integers/,
    );
  });

  it('are rejected on backends without compute shaders', () => {
    expect(() =>
      compile(scaleGraph().build(), { capabilities: { compute: false } }),
    ).toThrow(/the backend has no compute shaders/);
  });
});
