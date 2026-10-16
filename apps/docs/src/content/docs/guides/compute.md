---
title: Compute
description: Compute graphs, storage buffers, dispatches, and their rules.
sidebar:
  order: 3
---

A **compute graph** runs on the GPU outside of any draw: one thread per
item of work, grouped in workgroups. It is written with the nodes of the
material graphs, and writes **storage buffers**. Compute needs WebGPU or
Vulkan: WebGL2 has no compute shaders.

## A compute graph

```ts
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

const program = compile(g.build(), { capabilities: backend.capabilities });
```

- `g.compute({ workgroupSize })` ends the graph: the threads of a
  workgroup, in x, y and z (64 × 1 × 1 by default).
- The builtins give the position of the thread: `global-invocation-id`,
  `local-invocation-id`, `workgroup-id`, `num-workgroups` (`vec3<u32>`).
- `g.storage(name, arrayType(element), { access })` declares a buffer, an
  array of scalars, vectors or matrices whose length is the size of the
  buffer. `std.index` reads an element, `std.arrayLength` gives the length.
- `g.write(array, { index, value, when })` writes an element of a buffer
  declared `read-write`; `when` skips the write when false. A graph may
  write several times.

## Rules

The compiler refuses what would be wrong or unportable:

- the nodes that need another stage: `std.textureSample` needs the
  derivatives of a fragment shader, use `std.textureSampleLevel`;
- reading a buffer the graph writes: the threads run in any order;
- writing a buffer declared read-only;
- on a backend without compute (`capabilities.compute === false`): an
  explicit error.

A compute graph only has the resource slots it uses. Give it its inputs as
uniforms (a time, a size), set at each dispatch.

## Running a graph

`ComputeRunner` dispatches a program on its own, outside of a frame:

```ts
const runner = new ComputeRunner(backend);
runner.dispatch(program, {
  values: { input, output, factor: 2.5 },
  workgroups: [Math.ceil(count / 64)],
});
const result = new Float32Array(await output.read());
```

- `values`: the resources by name — uniform values, textures, samplers,
  storage buffers.
- `workgroups`: `[x, y?, z?]`, or `{ buffer, offset }`, a buffer holding the
  three counts as `u32` — an **indirect** dispatch, its size computed by the
  GPU. The buffer needs the `indirect` usage.
- The pipelines are cached by program; the bind groups and their uniform
  buffers by program and resources: dispatching again with the same
  buffers reuses them. The least recently used beyond
  `new ComputeRunner(backend, { bindGroups })` (256) are destroyed.

Storage buffers are created by the backend, with the usages they need:

```ts
const output = backend.buffers.create({
  size: count * 4,
  usage: ['storage', 'copy-src', 'copy-dst'],
});
```

`copy-src` allows `buffer.read()`; `initialData` fills a buffer at creation.

The GPU runs the submissions in order: a frame rendered after a dispatch
sees its results. A material reads a storage buffer with `g.storage()` too,
without the write access — see the [Compute tutorial](/fdw-engine/tutorials/compute/).

## In a render graph

`graph.addComputePass(name, setup)` declares a compute pass and its
resources (`storage-read`, `storage-write`, `indirect`…): it is ordered,
culled and synchronized with the other passes. Its `execute` receives a
`GpuComputePassEncoder`: `runner.record(pass, program, dispatch)` records a
dispatch there, with the caches of `dispatch`, submitted with the frame.
Several dispatches can share the pass:

```ts
graph.addComputePass('simulation', (pass) => {
  const written = pass.write(
    graph.importBuffer('state', state),
    'storage-write',
  );
  return {
    written,
    execute: (context) =>
      runner.record(context.pass, program, {
        values: { state },
        workgroups: [Math.ceil(count / 64)],
      }),
  };
});
```

The dispatches of a submission that bind the same resources share their
uniform values: the last ones written. `renderer.render({ prepare })`
adds passes to the graph of the frame, before those of the scene.

## On the backends

| Backend | Compute shaders                                                 |
| ------- | --------------------------------------------------------------- |
| WebGPU  | WGSL compute entry points                                       |
| Vulkan  | HLSL compiled to SPIR-V; barriers inserted before each dispatch |
| WebGL2  | None: compiling a compute graph fails, with the reason          |
