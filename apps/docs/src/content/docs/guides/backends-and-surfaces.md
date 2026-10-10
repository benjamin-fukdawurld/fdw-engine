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

## Capabilities

`backend.capabilities` says what a backend supports, and the compiler checks
the programs against it:

| Capability          | Meaning                                             | WebGL2                        |
| ------------------- | --------------------------------------------------- | ----------------------------- |
| `compute`           | Compute stages                                      | false                         |
| `storageBuffers`    | Storage buffers                                     | false                         |
| `maxVaryings`       | Values interpolated between the stages              | from the context              |
| `renderableFormats` | Color formats usable as attachments (`rgba16float`) | with `EXT_color_buffer_float` |

A graph using a missing feature fails to compile with an explicit error;
test the capability to offer a fallback.

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

## Pipelines

Pipelines are created on first use, which can stall a frame while a shader
compiles. `new Renderer(backend, { asyncPipelines: true })` creates them in
the background instead: an item is skipped until its pipeline is ready, and
`await renderer.whenReady()` waits for the pending ones (a loading screen).
WebGL2 links the programs in parallel when the browser has
`KHR_parallel_shader_compile`.
