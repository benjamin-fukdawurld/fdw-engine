# @fdw/engine-backend

Abstract API of FdwEngine — the contract layer between the frontend (`@fdw/engine-core`) and the concrete rendering backends (`@fdw/engine-webgpu`, …).

This package defines **interfaces, shared types and backend-agnostic logic**. It contains no code tied to a specific graphics API: each backend provides the concrete implementations (buffers, textures, math primitives, GPU memory layouts…).

## Position in the stack

```
engine-core      ← frontend (scene, camera, transforms, lights)
     │
engine-backend   ← abstract API (this package)
     │
engine-webgpu    ← concrete backend (WebGPU)
engine-…         ← future backends (Vulkan, DirectX, Metal…)
```

## Public API

### Engine & surface

| Export        | Kind      | Description                                                                                               |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `Engine`      | interface | Engine lifecycle: `init`, `pause`, `resume`, `destroy`, `state` signal                                    |
| `EngineState` | type      | `uninitialized` · `initializing` · `ready` · `paused` · `destroying` · `destroyed`                        |
| `Surface`     | interface | Where frames are rendered: `width`, `height`, `format`, `init(engine)`, `getCurrentTarget()`, `present()` |

`Engine` extends `EventTarget`, exposes its state as a [Preact signal](https://github.com/preactjs/signals), and its `RenderBackend` once ready.

### Rendering (`render/`)

An abstract rendering API modelled on WebGPU, which maps almost directly onto Vulkan, Metal and Direct3D 12.

| Export                                                                                              | Kind      | Description                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RenderBackend`                                                                                     | interface | Everything a renderer needs: buffer, texture and pipeline factories, math, render targets, command encoding and submission                                                  |
| `GpuPipelineFactory`                                                                                | interface | Physical layouts, render pipelines, bind group layouts (shared between equal groups) and bind groups                                                                        |
| `RenderPipelineDescriptor`, `PrimitiveState`, `DepthStencilState`, `ColorTargetState`, `BlendState` | type      | Pipeline description (`targets: []` for depth-only passes, `depthBias` / `depthBiasSlopeScale`, `sampleCount`); `alphaBlending` is the standard blend state                 |
| `GpuCommandEncoder`, `GpuRenderPassEncoder`, `RenderPassDescriptor`, `GpuRenderTarget`              | interface | Command recording (`setViewport` for a tile of an atlas; passes without color attachment; `resolveTarget` of a multisampled color attachment) and render targets            |
| `BackendCapabilities`                                                                               | type      | The compiler capabilities, `renderableFormats` (`rgba16float` for HDR) and `compressedFormats` (the compressed formats the device can sample)                               |
| `GpuComputePassEncoder`, `ComputePipelineDescriptor`, `GpuComputePipeline`                          | interface | Compute stages: `createComputePipeline()`, `beginComputePass()`, `dispatchWorkgroups()` (direct or indirect); refused on backends without the `compute` capability (WebGL2) |
| `matchVertexLayout()`, `isVertexFormatCompatible()`, `meshSemantics()`                              | function  | Matching of the program inputs with the mesh attributes, by semantic                                                                                                        |

### GPU resources (`gpu/`)

| Export                                                                                      | Kind      | Description                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GpuBuffer` / `GpuBufferFactory`                                                            | interface | GPU buffer and its factory                                                                                                                                                                                                     |
| `GpuBufferUsage`, `GpuBufferUpdateFrequency`                                                | type      | `uniform`, `storage`, `vertex`, `index`, `copy-src`, `copy-dst` · `static`, `dynamic`, `stream`                                                                                                                                |
| `GpuTexture` / `GpuTextureFactory`                                                          | interface | GPU texture and its factory: `createTexture({ …, source })` or `({ …, levels })` (precomputed levels, written as given), `writeTexture(texture, data, { level?, layer? })` (a level alone, or a layer of it, nothing computed) |
| `GpuTextureConfiguration`, `GpuTextureType`, `GpuTextureFormat`                             | type      | Texture description (`2d`, `2d-array`, `3d`, `cube`, formats, usages, `sampleCount` of multisampled attachments); compressed formats (BC1–BC7, ETC2/EAC, ASTC 4×4), sampled only                                               |
| `compressedBlock()`, `isCompressedFormat()`, `textureLevelSize()`, `levelDimensions()`      | function  | The blocks of a compressed format, the bytes of a layer of a level (rows of blocks for the compressed formats), the size of a level                                                                                            |
| `checkMipLevelCount()`, `checkTextureContent()`, `checkTextureWrite()`, `checkReadRegion()` | function  | The checks shared by the backends: levels, the content of a new texture, a write of a level, a read back                                                                                                                       |
| `GpuSampler` / `GpuSamplerFactory`                                                          | interface | Texture sampler and its factory                                                                                                                                                                                                |
| `GpuSamplerConfiguration`                                                                   | type      | Wrap / filter modes, anisotropy, `compare` (comparison samplers)                                                                                                                                                               |
| `GpuShaderStageName`                                                                        | type      | `vertex` · `fragment` · `compute`                                                                                                                                                                                              |

### Math (`math/`)

| Export                                                  | Kind  | Description                                                                         |
| ------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `IVec2`, `IVec3`, `IVec4`, `IQuat`, `Mat2/3/4`, `*Like` | type  | Math value types                                                                    |
| `Vec2View`, `Vec3View`, `Vec4View`, `QuatView`          | class | Typed views over a shared `ArrayBuffer`                                             |
| `Vec2Api` … `Mat4Api`, `PrimitivesAdapter`              | type  | Math primitive contracts, implemented by the backend                                |
| `TransformMath`, `CameraMath`                           | class | Local / normal matrices, view / projection matrices, built on a `PrimitivesAdapter` |

### Scene data

| Export                                                              | Kind  | Description                                                |
| ------------------------------------------------------------------- | ----- | ---------------------------------------------------------- |
| `TransformData`, `TransformSnapshot`                                | type  | Position / rotation / scale, versioned                     |
| `CameraData`, `CameraSnapshot`, `ProjectionData`                    | type  | Camera transform and perspective / orthographic projection |
| `CameraCache`                                                       | class | Cached view / projection matrices                          |
| `LightData`, `*LightSnapshot`, `LightType`                          | type  | Directional, point and spot lights                         |
| `MeshDescription`, `MeshInputData`, `Mesh`, `VertexAttributeFormat` | type  | Vertex buffer layout, attributes and index buffer          |

### Shaders (`shader/`)

Interfaces between the backend-independent programs compiled by `@fdw/engine-shader` and each backend.

| Export                                                                                  | Kind      | Description                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PhysicalLayoutStrategy`                                                                | interface | Resolves a logical `ProgramLayout` into binding numbers and uniform block offsets, following the rules of a backend         |
| `std140LayoutStrategy`                                                                  | const     | The layout of the GLSL family (WebGL2, Vulkan): std140 uniform blocks, std430 storage buffers, the groups and bindings kept |
| `PhysicalProgramLayout`, `PhysicalBindGroup`, `PhysicalBinding`, `PhysicalUniformBlock` | type      | The resolved layout                                                                                                         |
| `ShaderCodegen`                                                                         | interface | Translates the IR of a program into the language of a backend                                                               |
| `ShaderLanguage`, `ShaderSources`                                                       | type      | Target languages and generated sources                                                                                      |

### Utilities (`utils/`)

| Export             | Kind  | Description                                                              |
| ------------------ | ----- | ------------------------------------------------------------------------ |
| `SnapshotProvider` | type  | `{ version, value }` — a value that can be watched for changes           |
| `SnapshotValue`    | class | Wraps a getter and a version getter as a `SnapshotProvider`              |
| `CachedValue`      | class | Lazily recomputes its value only when a dependency's version has changed |

## Change tracking

Frontend objects (`Transform`, `Camera`, lights…) increment a `version` whenever they are modified. `CachedValue` compares dependency versions to recompute derived data (matrices, GPU buffers…) lazily, only when something has actually changed:

```ts
import { CachedValue, SnapshotValue } from '@fdw/engine-backend';

const source = new SnapshotValue({
  valueGetter: () => camera,
  versionGetter: () => camera.transformVersion,
});

const viewMatrix = new CachedValue({
  initialValue: new Float32Array(16),
  dependencies: [source],
  updateStrategy: (_, [camera]) =>
    cameraMath.getViewMatrix(
      camera.value.position.asArray(),
      camera.value.rotation.asArray(),
    ),
});

viewMatrix.value; // recomputed only if the camera moved
```

## Usage

The abstract API is used with a concrete backend that provides the factories and math implementations:

```ts
import { CameraCache } from '@fdw/engine-backend';
import { Camera } from '@fdw/engine-core';

const cache = new CameraCache(new Camera(), backend.cameraMath);

const viewProjection = cache.viewProjectionMatrix.value; // recomputed when the camera changes
```

## Implementing a new backend

A backend must provide:

- an `Engine` implementation (device creation and lifecycle);
- a `Surface` implementation for its windowing system;
- `GpuBufferFactory`, `GpuTextureFactory` and `GpuSamplerFactory`;
- a `PrimitivesAdapter` (math primitives), used to build `TransformMath` and `CameraMath`;
- a `ShaderCodegen` and a `PhysicalLayoutStrategy` (binding numbers, uniform offsets, `writeUniform`);
- a `RenderBackend`, with its `GpuPipelineFactory` and command encoding.

See `@fdw/engine-webgpu` for a reference implementation.
