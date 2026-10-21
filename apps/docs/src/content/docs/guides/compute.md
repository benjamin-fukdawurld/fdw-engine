---
title: Compute
description: Compute graphs, storage buffers, dispatches, and their rules.
sidebar:
  order: 3
---

A **compute graph** runs on the GPU outside of any draw: one thread per
item of work, grouped in workgroups. It is written with the nodes of the
material graphs, and writes **storage buffers**. It runs on every backend:
WebGL2, which has no compute shaders, runs it by rendering to textures
(see [On WebGL2](#on-webgl2)).

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
  explicit error. No backend of the engine is in this case.

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

| Backend | Compute stages                                                    |
| ------- | ----------------------------------------------------------------- |
| WebGPU  | WGSL compute entry points                                         |
| Vulkan  | HLSL compiled to SPIR-V; barriers inserted before each dispatch   |
| WebGL2  | Emulated by draws into textures; storage buffers in data textures |

## On WebGL2

WebGL2 has neither compute shaders nor storage buffers. The engine runs the
same graphs there by **rendering to textures**, the GPGPU of WebGL: its
capabilities say `compute: true`, `storageBuffers: true` and
`emulatedCompute: true`.

- **Storage buffers**: each has a copy in a data texture, `rgba32uint`, 16
  bytes per texel, the bytes of the buffer in order. Programs read their
  elements with `texelFetch`, materials included.
- **Dispatches**: each write of the graph is a draw of points into the
  texture of the buffer written, one point per thread (and per texel of the
  element: four for a `mat4`). The vertex shader runs the graph, places the
  point on the texel of the element, or out of the view when `when` is
  false; the fragment shader writes its bits. Elements smaller than a texel
  (`f32`, `vec2`) are written by masked draws, one per part of the texel.
  The builtins come from the vertex drawn (a single draw of all the
  points, not instanced) and from the workgroup counts.
- **The two copies** of a buffer are brought up to date from each other on
  the GPU, through pixel buffers, only when a use needs it: the texture
  before a dispatch or a draw that reads it, the buffer before a vertex
  fetch, a copy or `read()`. A buffer written by a dispatch can therefore be
  a vertex buffer.

What changes:

- **No indirect dispatch**: the counts would have to be read back first;
  `dispatchWorkgroupsIndirect` and the `indirect` usage throw.
- The same buffer cannot be bound twice, once read and once written, in a
  dispatch: an explicit error (the compiler already refuses a graph that
  reads the buffer it writes).
- A buffer holds at most `MAX_TEXTURE_SIZE` rows of 2048 texels (64 MB with
  the minimum of WebGL2).
- It is slower than compute shaders: a graph with several writes runs once
  per write, and the scalars four times. The features with another path
  prefer it there: the skinning stays in the vertex stage by default
  (`defaultSkinningMode`), but can be asked to compute.

The [GPU particles tutorial](/fdw-engine/tutorials/gpu-particles/) runs a
simulation on the three backends.
