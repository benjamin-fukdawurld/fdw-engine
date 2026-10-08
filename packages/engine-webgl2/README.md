# @fdw/engine-webgl2

WebGL2 backend of FdwEngine — a second implementation of the abstract API `@fdw/engine-backend`, for browsers without WebGPU. It renders the same material graphs as `@fdw/engine-webgpu`, with GLSL ES 3.00 generated from the same IR.

## Position in the stack

```
engine-core      ← frontend (scene, camera, transforms, lights, Renderer)
     │
engine-backend   ← abstract API
     │
engine-webgl2    ← concrete backend (this package)
```

## Public API

### Engine & surfaces

| Export                   | Kind  | Description                                                                                                                          |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WebGl2Engine`           | class | Implements `Engine`: creates the WebGL2 context, on an `OffscreenCanvas` owned by the engine by default, or on the `canvas` option   |
| `WebGl2CanvasSurface`    | class | Implements `Surface` on top of an `HTMLCanvasElement`: frames are rendered to a framebuffer and copied to the canvas on `present()`  |
| `WebGl2OffscreenSurface` | class | Implements `Surface` with a texture: render-to-texture, screenshots, headless tests (`readPixels()`, rows from the top as in WebGPU) |

### Rendering (`render/`)

| Export                  | Description                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebGl2RenderBackend`   | Implements `RenderBackend`: buffer, texture and pipeline factories, math, render targets, command encoding, capabilities (`maxVaryings`)                                                                                           |
| `WebGl2PipelineFactory` | Implements `GpuPipelineFactory`: GLSL generation, programs linked once per program key (in parallel with `KHR_parallel_shader_compile` for async pipelines), uniform block binding points and texture units assigned after linking |
| `WebGl2CommandEncoder`  | Records the commands of a frame and runs them on `submit()`, so that buffer writes are visible to every draw, as in WebGPU                                                                                                         |
| `WebGl2RenderTarget`    | Color targets (textures) and depth targets (renderbuffers), with their framebuffers                                                                                                                                                |

### GPU resources (`gpu/`)

| Export                                  | Description                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WebGl2BufferFactory`, `WebGl2Buffer`   | Implement `GpuBufferFactory` / `GpuBuffer`; the target of a buffer (vertex, index, uniform) is fixed by its usage |
| `WebGl2TextureFactory`, `WebGl2Texture` | Implement `GpuTextureFactory` and `GpuSamplerFactory`; immutable storage, uploads from images or typed arrays     |
| `WebGl2Sampler`                         | Implements `GpuSampler` with a WebGL2 sampler object                                                              |
| `glTextureFormat()`                     | Internal format, format and type of a texture format                                                              |

### Shaders (`shader/`)

| Export                            | Description                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GlslEsCodegen`                   | Implements `ShaderCodegen`: generates a vertex and a fragment shader in GLSL ES 3.00 from the IR of a program compiled by `@fdw/engine-shader` |
| `std140LayoutStrategy`            | Implements `PhysicalLayoutStrategy`: uniform blocks laid out with the std140 rules                                                             |
| `combinedSamplers()`              | The (texture, sampler) pairs sampled by a program, each one a `sampler2D` of the generated code                                                |
| `glslType()`, `glslSamplerType()` | GLSL names of shader types                                                                                                                     |

## Differences with WebGPU, absorbed by the backend

- **Clip space depth**: the engine produces [0, 1], as in WebGPU; the generated vertex shaders remap it to the [-1, 1] range of OpenGL.
- **Bind groups**: GLSL ES has no groups nor binding qualifiers. The pipeline assigns a binding point to each uniform block and a texture unit to each combined sampler; the resources are bound at draw time from the bind groups set on the pass.
- **Textures and samplers**: combined in the generated code, kept separate in the graph and the IR. WebGL2 sampler objects carry the sampling state.
- **Framebuffer origin**: bottom left; `readPixels()` returns rows from the top.

## Usage

```ts
import { Renderer } from '@fdw/engine-core';
import { WebGl2CanvasSurface, WebGl2Engine } from '@fdw/engine-webgl2';

const engine = new WebGl2Engine();
await engine.init();

const surface = new WebGl2CanvasSurface(canvas);
await surface.init(engine);

// The same renderer, materials and meshes as with WebGPU.
const renderer = new Renderer(engine.backend!);
renderer.render({ items, camera, surface, lights });
```

The `material-graph` and `loading-model` routes of [apps/demo](../../apps/demo) run on both backends: switch with the buttons of the header, or `?backend=webgl2`.

## Requirements

A browser with WebGL2 and `OffscreenCanvas` (all current browsers). Storage buffers are not available in WebGL2: graphs using them fail to compile with an explicit error.
