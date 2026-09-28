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

| Export                | Kind  | Description                                                                      |
| --------------------- | ----- | -------------------------------------------------------------------------------- |
| `WebGpuEngine`        | class | Implements `Engine`: requests the `GPUAdapter` / `GPUDevice` and manages the lifecycle |
| `WebGpuSurface`       | class | Implements `Surface` on top of an `HTMLCanvasElement` (`GPUCanvasContext`)       |
| `WebGpuSurfaceConfig` | type  | Surface options: `alphaMode`, `clearColor`                                       |

### GPU resources (`gpu/`)

| Export           | Kind  | Description                                                                 |
| ---------------- | ----- | --------------------------------------------------------------------------- |
| `BufferFactory`  | class | Implements `GpuBufferFactory`; supports initial data via `mappedAtCreation` |
| `Buffer`         | class | Implements `GpuBuffer`, wraps a `GPUBuffer`                                 |
| `TextureFactory` | class | Implements `GpuTextureFactory` and `GpuSamplerFactory`                      |
| `Texture`        | class | Implements `GpuTexture`, wraps a `GPUTexture`                               |
| `Sampler`        | class | Implements `GpuSampler`, wraps a `GPUSampler`                               |

### WGSL data layout (`gpu/`)

Implementations of the abstract layout API following WGSL alignment rules:

| Export                                                    | Description                                          |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `uniformLayout`, `uniformWriters`, `uniformSerializers`   | Layout, binary writer and WGSL declaration per primitive |
| `uniformPrimitives`, `uniformArrays`                      | Ready-to-use `GpuType`s and `GpuArray`s              |
| `uniformStructBuildStrategy`, `storageStructBuildStrategy` | Struct rules for uniform and storage buffers        |
| `uniformStructBuilder()`, `storageStruct()`               | Build a `GpuStruct` for a uniform / storage buffer   |

### Math (`math/`)

| Export                                         | Description                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `vec2`, `vec3`, `vec4`, `quat`, `mat3`, `mat4` | Math primitives implementing the abstract `*Api` contracts            |
| `transformMath`, `cameraMath`                  | `TransformMath` / `CameraMath` instances built on these primitives    |

### Shaders (`shader/`)

| Export          | Description                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| `ShaderWritter` | Generates WGSL code from [Eta](https://eta.js.org/) templates (`ShaderWritter.render(...)`) |

Available templates:

| Name                 | Content                                          |
| -------------------- | ------------------------------------------------ |
| `@base`              | Base shader layout                               |
| `@phong`             | Phong lighting shader                            |
| `@functions`         | Phong lighting functions                         |
| `@vertex-attributes` | Vertex input declarations from a mesh description |
| `@uniforms`          | Uniform declarations                             |
| `@textures`          | Texture and sampler declarations                 |

## Usage

```ts
import { Transform } from '@fdw/engine-core';
import { TransformAdapter } from '@fdw/engine-backend';
import {
  WebGpuEngine,
  WebGpuSurface,
  BufferFactory,
  transformMath,
} from '@fdw/engine-webgpu';

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

const transformAdapter = new TransformAdapter({
  transform: new Transform(),
  transformMath,
  bufferFactory,
});

// In the render pass:
const pass = encoder.beginRenderPass({
  colorAttachments: [surface.colorAttachment],
});
```

See [apps/demo](../../apps/demo) for complete examples.

## Requirements

A browser with WebGPU support (recent Chrome / Edge, Firefox Nightly, Safari Technology Preview…). `WebGpuEngine.init()` throws if `navigator.gpu` is not available.
