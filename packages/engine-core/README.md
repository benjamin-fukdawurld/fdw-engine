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

### Rendering (`render/`)

| Export        | Kind  | Description                                                                                                                                                                                                                   |
| ------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Material`    | class | A material graph (`@fdw/engine-shader`) with its values (uniforms, textures, samplers), its features (static parameters selecting a variant of the program) and its `RenderState`. Changing a value never recompiles anything |
| `RenderState` | type  | `alphaMode` (`opaque` / `mask` / `blend`; `mask` discards the fragments whose alpha is below the `alphaCutoff` value, 0.5 by default), `doubleSided`, `depthTest`, `depthWrite`                                               |
| `Mesh`        | class | CPU-side geometry: vertex buffers laid out as described by a `MeshDescription`, optional indices                                                                                                                              |
| `Renderer`    | class | Draws `RenderItem`s (`{ mesh, material, transform }`) on any `RenderBackend`                                                                                                                                                  |

## Design

All scene objects follow the same principles:

- **Snapshots**: each class implements the matching `*Snapshot` type from `@fdw/engine-backend` (`TransformSnapshot`, `CameraSnapshot`, `*LightSnapshot`), so backends can consume them without depending on this package.
- **Versioning**: every change increments a version counter (`version`, or `transformVersion` / `projectionVersion` for `Camera`). Backends use these counters to recompute derived data (matrices, GPU buffers…) only when needed.
- **Compact storage**: values are stored in a single `ArrayBuffer`, exposed through `Vec3View` / `QuatView`, which makes uploading them to the GPU cheap.
- **Partial updates**: setters accept partial values (`transform.position = { y: 2 }` keeps `x` and `z`).

## Rendering

```ts
import { Camera, Material, Renderer, Transform } from '@fdw/engine-core';
import { GraphBuilder, std, T } from '@fdw/engine-shader';

const g = new GraphBuilder('tinted');
g.surface({
  baseColor: g.uniform('color', BuiltinTypes.vec3f, { default: [1, 0.5, 0] }),
});
const material = new Material({ graph: g.build() });

const renderer = new Renderer(engine.backend);
renderer.render({
  items: [{ mesh, material, transform }],
  camera,
  surface,
  time,
});

material.setValue('color', [0, 0.5, 1]); // next frame: one buffer write
```

The renderer caches everything it creates:

- **Programs** are compiled once per graph and set of mesh attributes; **pipelines** once per program, vertex layout, render state and target formats.
- **Uniform buffers** follow the update frequencies of the design: the `frame` buffer (camera, time) is written every frame, an `object` buffer only when its transform changes, a `material` buffer only when the material version changes. Bind groups are rebuilt only when a buffer is recreated or a texture or sampler changes.
- **Frame and object bind groups are shared** by all the programs, since their layout is a fixed contract.
- **Draw order**: opaque items grouped by pipeline then material, then transparent items back to front.
- **Lights**: `render({ lights })` gives the lights of the frame — `DirectionalLight`, `PointLight` and `SpotLight` (cone from `innerCutoff` / `outerCutoff`, half-angles in degrees) — summed by the lit shading models. Up to 16 lights (`MaxLights`) are used.
- **Colors**: the materials compute **linear** colors. Color textures are created in an `-srgb` format (`rgba8unorm-srgb`), decoded by the GPU; data textures (normal, roughness, specular maps) stay linear. `new Renderer(backend, { output: { toneMapping, encoding } })` chooses the tone mapping (`none` by default, `reinhard`, `aces`, `neutral`) and the encoding of the surface (`srgb` by default, `linear`); `render({ exposure })` multiplies the colors before the tone mapping.
- **Asynchronous pipelines**: with `new Renderer(backend, { asyncPipelines: true })`, an item is skipped until its pipeline is ready instead of blocking the frame; `await renderer.whenReady()` waits for the pending ones.

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
