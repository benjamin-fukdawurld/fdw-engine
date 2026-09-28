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

| Export             | Kind      | Description                                                              |
| ------------------ | --------- | ------------------------------------------------------------------------ |
| `Engine`           | interface | Engine lifecycle: `init`, `pause`, `resume`, `destroy`, `state` signal   |
| `EngineState`      | type      | `uninitialized` · `initializing` · `ready` · `paused` · `destroying` · `destroyed` |
| `Surface`          | interface | Render target (`width`, `height`, `init(engine)`)                        |

`Engine` extends `EventTarget` and exposes its state as a [Preact signal](https://github.com/preactjs/signals).

### GPU resources (`gpu/`)

| Export                                   | Kind      | Description                                              |
| ---------------------------------------- | --------- | -------------------------------------------------------- |
| `GpuBuffer` / `GpuBufferFactory`         | interface | GPU buffer and its factory                               |
| `GpuBufferUsage`, `GpuBufferUpdateFrequency` | type  | `uniform`, `storage`, `vertex`, `index`, `copy-src`, `copy-dst` · `static`, `dynamic`, `stream` |
| `GpuTexture` / `GpuTextureFactory`       | interface | GPU texture and its factory                              |
| `GpuTextureConfiguration`, `GpuTextureType`, `GpuTextureFormat` | type | Texture description (`2d`, `2d-array`, `3d`, `cube`, formats) |
| `GpuSampler` / `GpuSamplerFactory`       | interface | Texture sampler and its factory                          |
| `GpuSamplerConfiguration`                | type      | Wrap / filter modes, anisotropy                          |
| `GpuShaderStageName`                     | type      | `vertex` · `fragment` · `compute`                        |

### GPU data layout (`gpu/`)

Describes how CPU-side values are laid out in GPU memory and how they are declared in shader code. Alignment rules depend on the backend and buffer kind (e.g. WGSL uniform vs storage), so the concrete rules are injected by the backend.

| Export                                          | Kind      | Description                                                   |
| ----------------------------------------------- | --------- | ------------------------------------------------------------- |
| `GpuType<T>`                                    | interface | Typed value: `size`, `alignment`, `write()`, `serialize()`    |
| `GpuArray<T>`                                   | interface | Fixed or runtime-sized array of a `GpuType`                   |
| `GpuStruct<T>` / `GpuStructField`               | interface | Struct made of named, offset fields                           |
| `GpuLayout`, `GpuWriter`, `GpuSerializer`       | interface | Building blocks: memory layout, binary writer, shader declaration |
| `LayoutApi`, `WriterApi`, `SerializerApi`       | type      | One layout / writer / serializer per primitive (`bool`, `int32`, `float32`, `vec2…4`, `quat`, `mat2…4`…) |
| `PrimitiveApi` / `primitiveApi()` / `primitiveOf()` | type / function | Combine layouts, writers and serializers into `GpuType`s |
| `ArrayApi` / `arrayApi()` / `arrayOf()`         | type / function | Same for `GpuArray`s                                     |
| `StructBuildStrategy`                           | interface | Backend-specific alignment and serialization rules for structs |
| `StructBuilder` / `struct()`                    | class / function | Build a `GpuStruct` from fields and a strategy          |

### Math (`math/`)

| Export                                                | Kind  | Description                                                     |
| ----------------------------------------------------- | ----- | --------------------------------------------------------------- |
| `IVec2`, `IVec3`, `IVec4`, `IQuat`, `Mat2/3/4`, `*Like` | type | Math value types                                               |
| `Vec2View`, `Vec3View`, `Vec4View`, `QuatView`        | class | Typed views over a shared `ArrayBuffer`                         |
| `Vec2Api` … `Mat4Api`, `PrimitivesAdapter`            | type  | Math primitive contracts, implemented by the backend            |
| `TransformMath`, `CameraMath`                         | class | Local / normal matrices, view / projection matrices, built on a `PrimitivesAdapter` |

### Scene data

| Export                                                         | Kind  | Description                                               |
| -------------------------------------------------------------- | ----- | --------------------------------------------------------- |
| `TransformData`, `TransformSnapshot`, `TransformParentProvider` | type | Position / rotation / scale, versioned                    |
| `TransformCache`, `TransformAdapter`                           | class | Cached local / world / normal matrices and their GPU buffers |
| `CameraData`, `CameraSnapshot`, `ProjectionData`               | type  | Camera transform and perspective / orthographic projection |
| `CameraCache`, `CameraAdapter`                                 | class | Cached view / projection matrices and their GPU buffers    |
| `LightData`, `*LightSnapshot`, `LightType`                     | type  | Directional, point and spot lights                        |
| `Material`, `MaterialDescription`, `MaterialBinding*`          | class / type | Material made of uniform, storage and texture bindings grouped in slots (`frame`, `material`, `object`) |
| `MeshDescription`, `MeshInputData`, `Mesh`, `VertexAttributeFormat` | type | Vertex buffer layout, attributes and index buffer   |

### Utilities (`utils/`)

| Export             | Kind  | Description                                                                 |
| ------------------ | ----- | --------------------------------------------------------------------------- |
| `SnapshotProvider` | type  | `{ version, value }` — a value that can be watched for changes              |
| `SnapshotValue`    | class | Wraps a getter and a version getter as a `SnapshotProvider`                 |
| `CachedValue`      | class | Lazily recomputes its value only when a dependency's version has changed   |

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
      camera.value.rotation.asArray()
    ),
});

viewMatrix.value; // recomputed only if the camera moved
```

## Usage

The abstract API is used with a concrete backend that provides the factories and math implementations:

```ts
import { TransformAdapter } from '@fdw/engine-backend';
import { Transform } from '@fdw/engine-core';
import { BufferFactory, transformMath } from '@fdw/engine-webgpu';

const adapter = new TransformAdapter({
  transform: new Transform({ position: { x: 0, y: 1, z: 0 } }),
  transformMath,
  bufferFactory: new BufferFactory(device),
});

const worldMatrixBuffer = adapter.worldMatrixBuffer.value; // GpuBuffer
```

## Implementing a new backend

A backend must provide:

- an `Engine` implementation (device creation and lifecycle);
- a `Surface` implementation for its windowing system;
- `GpuBufferFactory`, `GpuTextureFactory` and `GpuSamplerFactory`;
- a `PrimitivesAdapter` (math primitives), used to build `TransformMath` and `CameraMath`;
- the `LayoutApi` / `WriterApi` / `SerializerApi` and `StructBuildStrategy` matching its shading language.

See `@fdw/engine-webgpu` for a reference implementation.
