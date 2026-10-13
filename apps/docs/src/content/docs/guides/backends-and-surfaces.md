---
title: Backends and surfaces
description: Engines, surfaces and render backends; choosing one, and what differs between them.
sidebar:
  order: 6
---

Three objects separate an application from the graphics API it runs on.

| Object            | Role                                                                                     | Interface (`@fdw/engine-backend`) |
| ----------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| **Engine**        | The device: created by `init()`, released by `destroy()`; its `state` is a signal        | `Engine`                          |
| **Surface**       | Where frames go: a canvas, a window, a texture. `width`, `height`, `format`, `present()` | `Surface`                         |
| **RenderBackend** | What renderers use: buffer, texture and pipeline factories, math, command encoding       | `RenderBackend`, `engine.backend` |

The `Renderer`, the materials and the render graph only see the
`RenderBackend` and the `Surface`: code written against them runs everywhere.

## The backends

| Backend | Package              | Engine               | Surfaces                                                               | Shaders                         |
| ------- | -------------------- | -------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| WebGPU  | `@fdw/engine-webgpu` | `WebGpuEngine`       | `WebGpuSurface` (canvas), `WebGpuOffscreenSurface`                     | WGSL                            |
| WebGL2  | `@fdw/engine-webgl2` | `WebGl2Engine`       | `WebGl2CanvasSurface`, `WebGl2OffscreenSurface`                        | GLSL ES 3.00                    |
| Dawn    | `@fdw/engine-native` | `createDawnEngine()` | `DawnWindowSurface`, `WebGpuOffscreenSurface`                          | WGSL                            |
| Vulkan  | `@fdw/engine-vulkan` | `VulkanEngine`       | `VulkanWindowSurface` (`@fdw/engine-native`), `VulkanOffscreenSurface` | HLSL, compiled to SPIR-V by DXC |

Every backend passes the same rendering test suite.

```ts
const engine = new WebGpuEngine();
await engine.init();
const surface = new WebGpuSurface(canvas);
await surface.init(engine);
const backend = engine.backend!;
```

## Offscreen surfaces

An offscreen surface renders into a texture of a given size:
`new WebGpuOffscreenSurface(width, height, format?)`. Its `readPixels()`
returns the pixels as RGBA bytes, rows from the top, on every backend:
screenshots, thumbnails, tests.

## Reading textures back

`backend.textures.readTexture(texture, region?)` reads a region of a color
texture back (the whole texture by default), without waiting for the GPU:
its promise resolves a frame or two later, with the content the frames
submitted before left. The pixels come rows from the top, tightly packed,
in the layout of the format (4 bytes per pixel for `r32uint`).

```ts
const data = await backend.textures.readTexture(texture, {
  x: 10,
  y: 20,
  width: 4,
  height: 4,
});
```

The texture needs the `copy-src` usage (not in the default usage) and a
single sample; depth textures cannot be read. A region out of the texture
throws. WebGPU copies into a mapped buffer, WebGL2 reads into a pixel
buffer polled by a fence, Vulkan copies into a host buffer. `pickIds` is
built on it: see [Picking](/fdw-engine/tutorials/picking/).

## Capabilities

`backend.capabilities` says what a backend supports, and the compiler checks
the programs against it:

| Capability                         | Meaning                                             | WebGL2                                        |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `compute`                          | Compute stages                                      | false                                         |
| `storageBuffers`                   | Storage buffers                                     | false                                         |
| `maxVaryings`                      | Values interpolated between the stages              | from the context                              |
| `renderableFormats`                | Color formats usable as attachments (`rgba16float`) | with `EXT_color_buffer_float`                 |
| `objectTable`                      | The object data read from a table, per instance     | true (data textures)                          |
| `maxAnisotropy`                    | The highest anisotropy of the samplers              | with `EXT_texture_filter_anisotropic`, else 1 |
| `maxColorAttachments`              | Color targets of a pass                             | `MAX_DRAW_BUFFERS` (at least 4)               |
| `maxColorAttachmentBytesPerSample` | Bytes per pixel of the color targets (WebGPU)       | —                                             |
| `independentBlend`                 | Targets of a pipeline with different blend states   | false                                         |

A graph using a missing feature fails to compile with an explicit error;
test the capability to offer a fallback.

## Mipmaps and anisotropic filtering

A texture created with `mipLevelCount` has levels of detail, each half the
size of the previous one; `fullMipLevelCount(dimensions)` gives the whole
chain, down to 1×1. The data written fill the first level, and the backend
computes the others from it, on the GPU:

```ts
const map = backend.textures.createTexture({
  type: '2d',
  format: 'rgba8unorm-srgb',
  dimensions: { width: 512, height: 512 },
  mipLevelCount: fullMipLevelCount({ width: 512, height: 512 }),
  source: pixels,
});
```

After rendering into such a texture, `encoder.generateMipmaps(texture)`
computes its levels again (in a render graph: `addMipmapPass`). The sRGB
textures are averaged in linear colors. Levels are for the 2d, 2d-array and
cube textures of color formats, not multisampled: the other textures refuse
`mipLevelCount > 1`.

`std.textureSample` chooses the level from the size of the pixel on the
texture; `std.textureSampleLevel` reads a given one. The latter is available
in every stage: give it a uv through `std.perFragment`, or it samples at the
vertices and interpolates the colors.

**Anisotropic filtering** keeps a texture sharp on a surface seen at a
grazing angle (a floor, a road): the sampler takes up to `maxAnisotropy`
samples along the direction in which the texture is stretched.

```ts
const sampler = backend.textures.createSampler({ maxAnisotropy: 8 });
// Or for every sampler created afterwards without maxAnisotropy:
const engine = new WebGpuEngine({ maxAnisotropy: 8 });
backend.textures.defaultMaxAnisotropy = 8;
```

- It needs the three filters `linear` (the default): an anisotropy asked
  with a `nearest` filter throws, as WebGPU requires. The default only
  applies to the samplers that can use it, comparison samplers excepted.
- Values above `capabilities.maxAnisotropy` are clamped to it (16 on most
  GPUs, 1 where the device has no anisotropic filtering).
- It works with the mipmaps: without levels, a minified texture flickers
  whatever the anisotropy.

The backends compute the levels each in their way: `generateMipmap` in
WebGL2, a render pass per level in WebGPU, `vkCmdBlitImage` in Vulkan.

## What the backends absorb

The engine follows the conventions of WebGPU; the other backends adapt:

- **Clip space depth** goes from 0 to 1. The GLSL vertex shaders remap it to
  the −1 to 1 of OpenGL.
- **Framebuffer origin**: images are read from the top row everywhere.
  WebGL2 flips its viewports; Vulkan uses a negative viewport height, so that
  y points up in clip space.
- **Bind groups**: GLSL ES has none. The WebGL2 pipeline assigns a binding
  point to each uniform block and a texture unit to each texture–sampler
  pair; on Vulkan, groups are descriptor sets.
- **Uniform layouts**: WGSL rules on WebGPU, std140 on WebGL2 and Vulkan;
  the compiled programs know only the logical layout, the backend resolves
  the offsets.
- **Command recording**: WebGL2 records the commands of a frame and runs
  them on `submit()`, so that buffer writes are seen by every draw, as in
  WebGPU. Vulkan writes them as 32-bit words, replayed in one native call.
- **Synchronization**: WebGPU and WebGL2 are implicitly synchronized. The
  Vulkan library tracks the last use of each texture and buffer, and inserts
  the barriers.
- **Depth**: `depth24plus` is a 32-bit float depth on Vulkan.

## Object data and instancing

The data of each object drawn — its world and normal matrices, 112 bytes —
is a row of an **object table**, created by `backend.createObjectTable()`.
An object keeps its row while it lives; the row is written again only when
it moves, and the rows written in a frame go to the GPU in one range. Each
pass writes the rows of the instances it draws, in its order, then binds
the table once.

A draw gives `firstInstance`: its instance `i` reads the row
`instances[firstInstance + i]`. The objects that follow each other with the
same pipeline, material and mesh are **one draw** of several instances —
the renderer sorts by pipeline, material, then mesh to gather them.
`renderer.stats.get('scene')` gives `drawn` (the objects) and `drawCalls`
(the draws).

| Backend | Object table                                              | First instance                                              |
| ------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| WebGPU  | Two storage buffers: the rows, the row of each instance   | `instance_index` includes it                                |
| Vulkan  | Two storage buffers                                       | `SV_InstanceID` (the `InstanceIndex` of Vulkan) includes it |
| WebGL2  | Two data textures (RGBA32F, R32UI) read with `texelFetch` | A uniform set before each draw (no base instance)           |

The `Renderer` needs `createObjectTable`: a backend of your own implements
it (a `GpuObjectTable`: `writeRows`, `writeInstances`), and the
`object-table` binding of the programs.

## Pipelines

Pipelines are created on first use, which can stall a frame while a shader
compiles. `new Renderer(backend, { asyncPipelines: true })` creates them in
the background instead: an item is skipped until its pipeline is ready, and
`await renderer.whenReady()` waits for the pending ones (a loading screen).
WebGL2 links the programs in parallel when the browser has
`KHR_parallel_shader_compile`.
