# @fdw/engine-webgpu

WebGPU implementation of the `@fdw/engine-backend` abstraction.

Provides `WebGpuBackend` — the concrete class that manages a `GPUDevice`, canvas context, and all GPU resource creation via the WebGPU API.

## Public API

| Export          | Kind  | Description                                 |
| --------------- | ----- | ------------------------------------------- |
| `WebGpuBackend` | class | Implements `GpuBackend` using native WebGPU |

## Usage

```ts
import { WebGpuBackend } from '@fdw/engine-webgpu';

const backend = new WebGpuBackend();
await backend.init(canvas);

const buffer = backend.createBuffer({ size: 256, usage: BufferUsage.Uniform });
```

## Internal classes

These are not exported but back the abstract interfaces:

- `WebGpuBuffer` — wraps `GPUBuffer`, auto-adds `COPY_DST`
- `WebGpuTexture` — wraps `GPUTexture`
- `WebGpuSampler` — wraps `GPUSampler`
- `WebGpuShaderModule` — compiles WGSL into `GPUShaderModule`
- `WebGpuRenderPipeline` — translates abstract descriptor to `GPURenderPipeline`
- `WebGpuBindGroupLayout` / `WebGpuBindGroup` — resource binding
- `WebGpuRenderPass` — render pass encoder
- `WebGpuCommandEncoder` / `WebGpuCommandBuffer` — command recording

## Position in the stack

```
engine-backend  ← abstract interfaces
  └── engine-webgpu  ← this package
        └── engine-core  ← high-level Viewer / Camera / Renderer
```
