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
  `target`. Returns `{ color, depth, outputs }`: the versions they write
  (the color of `target`, the depth buffer, the outputs below). `name` (default
  `scene`) separates several views of a graph: each name has its own frame
  uniforms, so two cameras can be drawn in one frame. `linear: true` writes
  linear colors, for an HDR target. `inputs` binds textures of the graph to
  the textures of that name of the materials (a mirror image). When lights
  cast shadows, `shadows` is the version of their shadow atlas.
- `addFullscreenPass(graph, name, { material, inputs, target, format })`: a
  full screen material, its textures bound to resources of the graph by
  `inputs`. It reads the camera and the lights of the last scene passes
  added (a deferred lighting pass), and their shadow maps with
  `shadows: scene.shadows`. With `targets`, it also writes the extra color targets of the
  material (`g.target`), by name, and returns `{ color, targets }`:

  ```ts
  const pass = renderer.addFullscreenPass(graph, 'split', {
    material, // g.fullscreen({ color }); g.target('mask', mask, 1)
    target: graph.createTexture('color', { format: 'rgba8unorm' }),
    format: 'rgba8unorm',
    targets: {
      mask: {
        target: graph.createTexture('mask', { format: 'r8unorm' }),
        format: 'r8unorm',
      },
    },
  });
  pass.targets.mask; // the version written, to read in later passes
  ```

  The number of targets is limited by `capabilities.maxColorAttachments`
  (4 at least, 8 on most GPUs), and their bytes per pixel by
  `maxColorAttachmentBytesPerSample` on WebGPU (32). WebGL2 blends all its
  float targets the same way (`independentBlend` is false).

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
// … a pass drawing `inset.color` over `main.color` …
runner.execute(graph);
surface.present();
```

## Scene outputs

Besides their color, the scene passes write the **outputs** you ask for,
each in its texture (multiple render targets), as many as the backend
allows, named as you like:

```ts
const scene = renderer.addScenePasses(graph, {
  items,
  camera,
  target: graph.createTexture('color', { format: 'rgba8unorm' }),
  format: 'rgba8unorm',
  outputs: {
    normal: { format: 'rgba16float', value: 'view-normal' },
    id: { format: 'r32uint', value: 'object-id' },
    properties: { format: 'rgba8unorm', value: packProperties },
    velocity: { format: 'rg16float', value: 'material', default: [0, 0] },
  },
});
scene.outputs.normal; // a version to read in later passes
```

What an output holds:

- **A value of the surface or of the engine**: `view-normal`,
  `world-normal`, `view-depth`, `world-position`, `object-id`, `uv`, or an
  input of the surface (`base-color`, `alpha`, `emissive`, `roughness`,
  `metallic`, `occlusion`…, its default when the shading model has none).
  Converted to the format (missing components are 0, and 1 for the 4th).
- **A function graph of yours** (`defineFunction`), the same for every
  material: its inputs are named after these values (`viewNormal`,
  `baseColor`, `objectId`…) and its output is written. Pack several values
  in one target, encode them, compute what the engine does not know.
- **`'material'`**: each material writes it with `g.output(name, value)`;
  the others write `default`.

The functions and the materials give values of the type of the format:
`vec2f` for `rg16float`, `u32` for `r32uint`, `vec4f` for `rgba8unorm`.

- **Without `target`**, the passes only write their outputs, without the
  shading models: a G-buffer for deferred rendering (`size` gives the size
  of the textures, the frame by default).
- **Identifiers**: give `id` (1 to 2^24) to the items; `object-id` writes it
  for their pixels, 0 elsewhere. `pickIds` reads those of a region of an
  `r32uint` texture back (see [Picking](/fdw-engine/tutorials/picking/)).
  Beyond 2^24 objects, select by ray casting
  (`scene.raycast`) rather than with an identifier buffer.
- **Transparent items only blend their color**: they write no output, and
  cannot be selected through `object-id`.
- `samples` sets the multisampling of a call (the renderer's by default).
  Outputs of integer formats are not multisampled: draw them in a call with
  `samples: 1`.
- `depth` gives a depth buffer written by earlier passes, and
  `include: 'opaque' | 'transparent'` the items drawn: a G-buffer of the
  opaque items, then the transparent ones over the composed image.
- `faces: 'back'` draws the back faces of the one-sided items instead of
  their front faces: the depth of the far side of the objects, their
  thickness (see [Reflections](/fdw-engine/tutorials/reflections/)).

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
