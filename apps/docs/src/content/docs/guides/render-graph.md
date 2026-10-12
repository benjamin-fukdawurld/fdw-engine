---
title: Render graph
description: Describe a frame as passes reading and writing resources; the engine orders, culls and allocates.
sidebar:
  order: 2
---

A frame is a set of **passes** — draws, computations, copies — that read and
write **resources** — textures and buffers. `RenderGraph` describes them,
`RenderGraphRunner` compiles and runs them. `Renderer.render()` is itself a
small graph; build your own to add passes.

## Resources

```ts
const graph = new RenderGraph();
const surface = graph.importTexture('surface', target.getCurrentTarget());
const hdr = graph.createTexture('hdr', { format: 'rgba16float' });
const half = graph.createTexture('half', {
  format: 'rgba8unorm',
  size: { relative: 0.5 },
});
const counts = graph.createBuffer('counts', { size: 16 });
```

- **Imported** resources (`importTexture`, `importBuffer`) exist outside of
  the graph: the image of a surface, the buffers of the scene. Writing one is
  a **side effect**: what the frame is for.
- **Transient** resources (`createTexture`, `createBuffer`) only exist while
  the frame runs. The runner takes them from a pool, and gives them back
  after the last pass using them: a later pass of the same frame, or the next
  frame, reuses them.
- A texture size is absolute (`{ width, height }`) or relative to the frame
  (`{ relative: 0.5 }`); by default, the size of the frame: the first
  imported texture, or the `size` given to `execute`.
- `sampleCount: 4` makes a multisampled attachment, resolved into a texture
  with `pass.resolveColor()`.
- `mipLevelCount` gives a texture levels of detail (`'full'`: down to 1×1,
  for the size it gets). `graph.addMipmapPass(name, texture)` computes them
  from the first level and returns the version to sample (a blur, a bloom,
  an average).

## Passes and versions

A pass declares what it reads and writes, and returns what it produces with
its `execute` function:

```ts
const lit = graph.addRasterPass('lit', (pass) => ({
  color: pass.writeColor(hdr, {
    load: 'clear',
    clearValue: { r: 0, g: 0, b: 0, a: 1 },
  }),
  depth: pass.writeDepth(depth, { load: 'clear', clearValue: 1 }),
  execute: ({ pass: encoder, texture, size }) => {
    // encoder: a GpuRenderPassEncoder; texture(handle): the real texture.
  },
}));
```

Each write returns a **new version** of the resource. A pass reading
`lit.color` reads that version: it runs after `lit`. The dependencies are
those of the versions, never of the declaration order.

| Method                          | Pass   | Usage                                                                           |
| ------------------------------- | ------ | ------------------------------------------------------------------------------- |
| `writeColor(texture, { load })` | raster | Color attachment; `clear` discards the content                                  |
| `writeDepth(texture, { load })` | raster | Depth attachment                                                                |
| `readDepth(texture)`            | raster | Depth test without writes                                                       |
| `resolveColor(texture)`         | raster | Resolves the last multisampled attachment                                       |
| `read(handle, usage)`           | all    | `sampled`, `storage-read`, `uniform`, `vertex`, `index`, `indirect`, `copy-src` |
| `write(handle, usage)`          | all    | `storage-write`, `copy-dst`                                                     |
| `hasSideEffects()`              | all    | Keeps the pass even if nobody reads it                                          |

Three kinds of passes open three kinds of encoders:

- `addRasterPass`: a render pass, with its attachments (`context.pass`);
- `addComputePass`: a compute pass (`context.pass`, WebGPU and Vulkan);
- `addCopyPass`: the command encoder, for copies and mipmaps
  (`context.encoder`).

In `execute`, `context.texture(handle)` and `context.buffer(handle)` give the
real resources, `context.size(handle)` the size of a texture.

## The renderer in your graph

The `Renderer` adds its passes to a graph:

- `addScenePasses(graph, { source, camera, target, format })` (or `items`
  instead of `source`, and `lights`, `layers`): the
  shadow maps, the opaque and the transparent items, drawing into
  `target`. Returns the version of `target` they write. `name` (default
  `scene`) separates several views of a graph: each name has its own frame
  uniforms, so two cameras can be drawn in one frame. `linear: true` writes
  linear colors, for an HDR target.
- `addFullscreenPass(graph, name, { material, inputs, target, format })`: a
  full screen material, its textures bound to resources of the graph by
  `inputs`.

```ts
const runner = new RenderGraphRunner(backend);
const graph = new RenderGraph();
const output = graph.importTexture('surface', surface.getCurrentTarget());
// Two views: the scene, and a picture in picture from above.
const main = renderer.addScenePasses(graph, {
  items,
  camera,
  lights,
  target: output,
  format: surface.format,
});
const inset = renderer.addScenePasses(graph, {
  name: 'top',
  items,
  camera: topCamera,
  lights,
  target: graph.createTexture('top', {
    format: 'rgba8unorm',
    size: { width: 320, height: 180 },
  }),
  format: 'rgba8unorm',
});
// … a pass drawing `inset` over `main` …
runner.execute(graph);
surface.present();
```

## Compilation

`runner.execute(graph)` compiles the graph, then records it in one command
encoder, submitted once:

1. **Culling**: from the passes with side effects, back along the versions
   they read. The other passes are dropped, with the resources only they
   used.
2. **Order**: topological, by versions; at equal dependencies, the order of
   declaration.
3. **Lifetimes**: the first and last pass of each transient resource, and
   the union of its usages (for its creation flags).
4. **Transitions**: the changes of usage between passes, turned into
   barriers by the backends that need them (Vulkan).

The compilation is **cached by structure**: the passes, their kinds, the
resources, their descriptors and usages. Rebuilding the same graph each
frame only redoes the declarations. `runner.compilations` and
`runner.created` count the compilations and the textures created, to check
that a frame reuses them.

## Debugging

`graph.toDot()` describes the compiled graph for
[Graphviz](https://graphviz.org): the passes kept and culled, the versions
of the resources between them.

```ts
console.log(graph.toDot()); // dot -Tsvg frame.dot > frame.svg
```

### GPU time of the passes

With the `timing` option, the runner measures the GPU duration of each
render and compute pass:

```ts
const runner = new RenderGraphRunner(backend, { timing: true });
// Every frame:
runner.execute(graph);
for (const [pass, milliseconds] of runner.passTimes) {
  console.log(pass, milliseconds.toFixed(3));
}
```

- The GPU answers a few frames late: `passTimes` gives the latest frame
  measured, and is empty at first. It never waits for the GPU.
- Two passes of the same name add up.
- Where the GPU cannot measure, `passTimes` stays empty: WebGPU needs the
  `timestamp-query` feature (asked for by `WebGpuEngine` when the adapter
  has it), WebGL2 the `EXT_disjoint_timer_query_webgl2` extension; Vulkan
  measures when its queue writes timestamps.
- A backend gives the measures through `createPassTimer(capacity)`: a pass
  given `timing: { timer, index }` is measured into that slot.
