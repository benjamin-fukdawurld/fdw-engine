# @fdw/engine-core

Frontend of FdwEngine — the high-level API used to build and manipulate 3D scenes **without caring about the underlying rendering technology**.

This package depends only on the abstract API (`@fdw/engine-backend`). The same scene code works with any backend (WebGPU today, other technologies later).

## Position in the stack

```
engine-core      ← frontend (this package)
     │
engine-backend   ← abstract API
     │
engine-webgpu    ← concrete backend (WebGPU)
engine-…         ← future backends (Vulkan, DirectX, Metal…)
```

## Public API

| Export             | Kind  | Description                                                                         |
| ------------------ | ----- | ----------------------------------------------------------------------------------- |
| `Transform`        | class | Position, rotation (quaternion) and scale of an object                              |
| `Camera`           | class | Position, rotation and perspective / orthographic projection                        |
| `BaseLight`        | class | Base class for lights: `ambient`, `diffuse` and `specular` colors                   |
| `DirectionalLight` | class | Light with a `direction`                                                            |
| `PointLight`       | class | Light with a `position` and constant / linear / quadratic attenuation               |
| `SpotLight`        | class | Light with a `position`, a `direction`, attenuation and inner / outer cutoff angles |

> `DirectionalLight`, `PointLight` and `SpotLight` are defined in `src/light/` but not yet re-exported from the package entry point.

## Design

All scene objects follow the same principles:

- **Snapshots**: each class implements the matching `*Snapshot` type from `@fdw/engine-backend` (`TransformSnapshot`, `CameraSnapshot`, `*LightSnapshot`), so backends can consume them without depending on this package.
- **Versioning**: every change increments a version counter (`version`, or `transformVersion` / `projectionVersion` for `Camera`). Backends use these counters to recompute derived data (matrices, GPU buffers…) only when needed.
- **Compact storage**: values are stored in a single `ArrayBuffer`, exposed through `Vec3View` / `QuatView`, which makes uploading them to the GPU cheap.
- **Partial updates**: setters accept partial values (`transform.position = { y: 2 }` keeps `x` and `z`).

## Usage

```ts
import { Camera, Transform } from '@fdw/engine-core';

const transform = new Transform({
  position: { x: 0, y: 0, z: -5 },
  scale: { x: 2, y: 2, z: 2 },
});
transform.position = { y: 1 }; // transform.version is incremented

const camera = new Camera({
  position: { x: 0, y: 0, z: 10 },
  projection: {
    type: 'perspective',
    fov: 45,
    aspect: canvas.width / canvas.height,
    near: 0.1,
    far: 100,
  },
});
```

Rendering these objects is the backend's job, for instance through `TransformAdapter` and `CameraAdapter` from `@fdw/engine-backend`, combined with the factories of `@fdw/engine-webgpu`.
