# @fdw/engine-webgpu

WebGPU backend of FdwEngine — the concrete implementation of the abstract API `@fdw/engine-backend`, for rendering in the browser.

## Position in the stack

```
engine-core      ← frontend (scene, camera, transforms, lights)
     │
engine-backend   ← abstract API
     │
engine-webgpu    ← concrete backend (this package)
```

## Public API

### Engine & surface

| Export                   | Kind  | Description                                                                                                                                                                                    |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebGpuEngine`           | class | Implements `Engine`: requests the `GPUAdapter` / `GPUDevice`, manages the lifecycle and exposes the `backend` once ready. Accepts a `gpu` option to run outside a browser (e.g. Dawn for Node) |
| `WebGpuSurface`          | class | Implements `Surface` on top of an `HTMLCanvasElement` (`GPUCanvasContext`)                                                                                                                     |
| `WebGpuOffscreenSurface` | class | Implements `Surface` with a texture: render-to-texture, screenshots, headless tests (`readPixels()`)                                                                                           |
| `WebGpuSurfaceConfig`    | type  | Surface options: `alphaMode`, `clearColor`                                                                                                                                                     |

### Rendering (`render/`)

| Export                                       | Description                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebGpuRenderBackend`                        | Implements `RenderBackend`: buffer, texture and pipeline factories, math, render targets, command encoding; `compressedFormats` from the `texture-compression-bc`, `-etc2` and `-astc` features (`WebGpuEngine` asks for those the adapter has) |
| `WebGpuPipelineFactory`                      | Implements `GpuPipelineFactory`: WGSL generation, shader modules and bind group layouts cached, explicit pipeline layouts                                                                                                                       |
| `WebGpuCommandEncoder`, `WebGpuRenderTarget` | Command recording and render targets                                                                                                                                                                                                            |

### GPU resources (`gpu/`)

| Export                                       | Kind               | Description                                                                                                            |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `BufferFactory`                              | class              | Implements `GpuBufferFactory`; supports initial data via `mappedAtCreation`                                            |
| `Buffer`                                     | class              | Implements `GpuBuffer`, wraps a `GPUBuffer`                                                                            |
| `TextureFactory`                             | class              | Implements `GpuTextureFactory` and `GpuSamplerFactory`; levels and compressed blocks written with `queue.writeTexture` |
| `compressedFormats()`, `CompressionFeatures` | function, constant | The compressed formats of the features of a device                                                                     |
| `Texture`                                    | class              | Implements `GpuTexture`, wraps a `GPUTexture`                                                                          |
| `Sampler`                                    | class              | Implements `GpuSampler`, wraps a `GPUSampler`                                                                          |

### Math (`math/`)

| Export                                         | Description                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `vec2`, `vec3`, `vec4`, `quat`, `mat3`, `mat4` | Math primitives implementing the abstract `*Api` contracts         |
| `transformMath`, `cameraMath`                  | `TransformMath` / `CameraMath` instances built on these primitives |

### Shaders (`shader/`)

| Export               | Description                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WgslCodegen`        | Implements `ShaderCodegen`: generates a WGSL module (`vs_main`, `fs_main`) from the IR of a program compiled by `@fdw/engine-shader` |
| `wgslLayoutStrategy` | Implements `PhysicalLayoutStrategy`: one bind group per slot, uniform blocks laid out with the WGSL uniform address space rules      |
| `wgslType()`         | WGSL name of a shader type                                                                                                           |

## Usage

```ts
import { WebGpuEngine, WebGpuSurface, BufferFactory } from '@fdw/engine-webgpu';

const engine = new WebGpuEngine();
await engine.init();

const surface = new WebGpuSurface(canvas, {
  clearColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
});
await surface.init(engine);

const bufferFactory = new BufferFactory(engine.device!);

const vertexBuffer = bufferFactory.create({
  size: vertices.byteLength,
  usage: ['vertex', 'copy-dst'],
  initialData: vertices,
  label: 'vertices',
});

// In the render pass:
const pass = encoder.beginRenderPass({
  colorAttachments: [surface.colorAttachment],
});
```

See [apps/demo](../../apps/demo) for complete examples.

## Requirements

A browser with WebGPU support (recent Chrome / Edge, Firefox Nightly, Safari Technology Preview…). `WebGpuEngine.init()` throws if `navigator.gpu` is not available.
