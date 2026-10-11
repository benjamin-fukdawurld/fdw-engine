import type { GpuBindGroupEntry } from '@fdw/engine-backend';
import {
  arrayType,
  BuiltinTypes,
  CompiledProgram,
  ProgramLayout,
  ShaderModuleIR,
} from '@fdw/engine-shader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebGpuEngine } from '../WebGpuEngine';
import { WgslCodegen } from './WgslCodegen';
import { wgslLayoutStrategy } from './wgslLayoutStrategy';
import { canRun } from '@fdw/engine-backend/testing';

// Compute stages, written directly in IR (the compute graphs compile to it):
// output[i] = input[i] × factor, for i < arrayLength(input).
const layout: ProgramLayout = {
  groups: [
    {
      slot: 'compute',
      bindings: [
        {
          kind: 'uniform-block',
          name: 'computeUniforms',
          members: [{ name: 'factor', type: BuiltinTypes.f32 }],
        },
        {
          kind: 'storage-buffer',
          name: 'input',
          type: arrayType(BuiltinTypes.f32),
          access: 'read',
        },
        {
          kind: 'storage-buffer',
          name: 'output',
          type: arrayType(BuiltinTypes.f32),
          access: 'read-write',
        },
      ],
    },
  ],
};

const scaleModule: ShaderModuleIR = {
  name: 'scale',
  entryPoints: [
    {
      stage: 'compute',
      inputs: [],
      outputs: [],
      workgroupSize: [64, 1, 1],
      body: [
        {
          id: 1,
          type: BuiltinTypes.vec3u,
          op: { kind: 'load-builtin', builtin: 'global-invocation-id' },
          args: [],
        },
        {
          id: 2,
          type: BuiltinTypes.u32,
          op: { kind: 'swizzle', components: 'x' },
          args: [1],
          name: 'index',
        },
        {
          id: 3,
          type: arrayType(BuiltinTypes.f32),
          op: { kind: 'load-resource', binding: 'input' },
          args: [],
        },
        {
          id: 4,
          type: BuiltinTypes.f32,
          op: { kind: 'index' },
          args: [3, 2],
        },
        {
          id: 5,
          type: BuiltinTypes.f32,
          op: {
            kind: 'load-resource',
            binding: 'computeUniforms',
            member: 'factor',
          },
          args: [],
        },
        {
          id: 6,
          type: BuiltinTypes.f32,
          op: { kind: 'binary', operator: '*' },
          args: [4, 5],
          name: 'scaled',
        },
        {
          id: 7,
          type: BuiltinTypes.u32,
          op: { kind: 'array-length' },
          args: [3],
        },
        {
          id: 8,
          type: BuiltinTypes.bool,
          op: { kind: 'compare', operator: '<' },
          args: [2, 7],
        },
      ],
      results: {},
      writes: [{ resource: 'output', index: 2, value: 6, condition: 8 }],
    },
  ],
};

const program: CompiledProgram = {
  name: 'scale',
  programKey: 'compute-test-scale',
  variantKey: {},
  module: scaleModule,
  layout,
  vertexInputs: [],
  diagnostics: [],
};

describe('WGSL compute stages', () => {
  it('generates a cs_main entry point with its writes after the body', () => {
    const sources = new WgslCodegen().emit(
      scaleModule,
      wgslLayoutStrategy.resolve(layout)
    );
    if (sources.kind !== 'single-module') {
      throw new Error('expected a single module');
    }
    expect(sources.entryPoints).toEqual({ compute: 'cs_main' });
    expect(sources.code).toContain(
      '@group(0) @binding(2) var<storage, read_write> b_output: array<f32>;'
    );
    expect(sources.code).toContain(
      '@compute @workgroup_size(64, 1, 1)\nfn cs_main(@builtin(global_invocation_id) globalInvocationId: vec3<u32>) {'
    );
    expect(sources.code).toMatch(
      /let v8: bool = v2_index < v7;\n {2}if \(v8\) \{\n {4}b_output\[v2_index\] = v6_scaled;\n {2}\}\n\}/
    );
  });
});

// Runs the compute stage with Dawn, the WebGPU implementation of Chrome, in
// Node. Skipped where Dawn cannot load.
const dawn = await import('webgpu').catch(() => undefined);
const ready = canRun('dawn', !!dawn, 'the webgpu package (Dawn) did not load');

describe.skipIf(!ready)('compute stages on WebGPU (Dawn)', () => {
  let engine: WebGpuEngine;

  beforeAll(async () => {
    Object.assign(globalThis, dawn!.globals);
    engine = new WebGpuEngine({ gpu: dawn!.create([]) });
    await engine.init();
  });

  afterAll(() => engine?.destroy());

  it('dispatches a compute stage and reads its result back', async () => {
    const backend = engine.backend!;
    const device = engine.device!;
    device.pushErrorScope('validation');

    // 100 values: two workgroups of 64, the last 28 threads write nothing.
    const count = 100;
    const values = Float32Array.from({ length: count }, (_, i) => i - 10);
    const input = backend.buffers.create({
      label: 'input',
      size: values.byteLength,
      usage: ['storage', 'copy-dst'],
      initialData: values,
    });
    const output = backend.buffers.create({
      label: 'output',
      // Room for a sentinel after the last element.
      size: values.byteLength + 4,
      usage: ['storage', 'copy-src', 'copy-dst'],
      initialData: new Float32Array(count + 1).fill(-1),
    });

    const physical = backend.pipelines.resolveLayout(program);
    const group = physical.groups[0];
    const block = group.bindings[0].block!;
    const uniforms = new DataView(new ArrayBuffer(block.size));
    backend.pipelines.layoutStrategy.writeUniform(
      uniforms,
      block.members[0],
      2.5
    );
    const uniformBuffer = backend.buffers.create({
      size: block.size,
      usage: ['uniform', 'copy-dst'],
      initialData: new Uint8Array(uniforms.buffer),
    });
    const entries: GpuBindGroupEntry[] = [
      { binding: 0, resource: uniformBuffer },
      { binding: 1, resource: input },
      { binding: 2, resource: output },
    ];
    const bindGroup = backend.pipelines.createBindGroup(
      backend.pipelines.createBindGroupLayout(group),
      entries
    );

    const pipeline = await backend.pipelines.createComputePipelineAsync({
      program,
    });
    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginComputePass('scale');
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    backend.submit([encoder.finish()]);

    const result = new Float32Array(await output.read());
    expect([...result.subarray(0, count)]).toEqual(
      [...values].map((value) => value * 2.5)
    );
    // The guard kept the threads past the end of the input from writing.
    expect(result[count]).toBe(-1);
    expect((await device.popErrorScope())?.message).toBeUndefined();
  });

  it('reads a part of a buffer back', async () => {
    const backend = engine.backend!;
    const buffer = backend.buffers.create({
      size: 16,
      usage: ['copy-src', 'copy-dst'],
      initialData: new Uint32Array([1, 2, 3, 4]),
    });
    expect([...new Uint32Array(await buffer.read(4, 8))]).toEqual([2, 3]);
  });
});
