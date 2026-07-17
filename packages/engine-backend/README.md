# @fdw/engine-backend

Hardware-agnostic GPU abstraction layer.

Defines interfaces for Device, Buffer, Texture, Pipeline, RenderPass, Shader, BindGroup, and Command encoding. Implementations (WebGPU, WebGL, …) live in separate packages.

## Public API

| Export                                              | Kind      | Description                                               |
| --------------------------------------------------- | --------- | --------------------------------------------------------- |
| `GpuBackend`                                        | interface | Main factory — creates buffers, textures, pipelines, etc. |
| `GpuBuffer` / `GpuBufferDescriptor`                 | interface | GPU buffer abstraction                                    |
| `GpuTexture` / `GpuTextureDescriptor`               | interface | GPU texture abstraction                                   |
| `GpuSampler` / `GpuSamplerDescriptor`               | interface | Texture sampler                                           |
| `GpuShaderModule` / `GpuShaderModuleDescriptor`     | interface | Compiled shader module                                    |
| `GpuRenderPipeline` / `GpuRenderPipelineDescriptor` | interface | Full render pipeline state                                |
| `GpuBindGroup` / `GpuBindGroupLayout`               | interface | Resource binding                                          |
| `GpuRenderPass` / `GpuRenderPassDescriptor`         | interface | Render pass encoder                                       |
| `GpuCommandEncoder` / `GpuCommandBuffer`            | interface | Command recording & submission                            |
| `BufferUsage`, `TextureFormat`, `TextureUsage`      | enum      | Usage/format flags                                        |

## Usage

```ts
import type { GpuBackend, GpuBuffer } from '@fdw/engine-backend';

function uploadMesh(backend: GpuBackend, data: Float32Array): GpuBuffer {
  const buf = backend.createBuffer({
    label: 'mesh-vbo',
    size: data.byteLength,
    usage: BufferUsage.Vertex,
  });
  buf.write(data);
  return buf;
}
```

## Position in the stack

```
engine-backend  ← abstract interfaces (this package)
  └── engine-webgpu  ← concrete WebGPU implementation
        └── engine-core  ← high-level Viewer / Camera / Renderer
```
