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

| Export             | Kind  | Description                                                                                                              |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| `Transform`        | class | Position, rotation (quaternion) and scale of an object: a block of a `TransformPool`, with its world and normal matrices |
| `TransformPool`    | class | Transforms in blocks of a `Float32Array`, laid out as the object uniforms; grown by a factor (2) when full               |
| `Camera`           | class | Position, rotation and perspective / orthographic projection                                                             |
| `BaseLight`        | class | Base class for lights: `ambient`, `diffuse` and `specular` colors                                                        |
| `DirectionalLight` | class | Light with a `direction`; casts shadows with `castShadow` (see `ShadowOptions`)                                          |
| `PointLight`       | class | Light with a `position` and constant / linear / quadratic attenuation                                                    |
| `SpotLight`        | class | Light with a `position`, a `direction`, attenuation and inner / outer cutoff angles; casts shadows with `castShadow`     |
| `ShadowOptions`    | type  | `bias`, `normalBias` (in texels), `bounds` (the sphere covered by a directional light)                                   |

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
- **Pooled transforms**: a `Transform` is a block of a `TransformPool` (the default one, or one given to its constructor): local values, world and normal matrices, laid out as the `object` uniform block, uploaded in one copy. `dispose()` frees the block at once; otherwise the garbage collector does, through a `FinalizationRegistry`.
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
- **Renderer on the render graph**: `render()` builds a graph each frame (the surface image, a transient depth buffer, an `opaque` pass and, when needed, a `transparent` one); `renderer.addScenePasses(graph, { items, camera, target, format })` adds these passes to your own graph and returns what they write: `{ color, depth, outputs }`.
- **Scene outputs**: `addScenePasses(graph, { outputs })` also writes other targets (multiple render targets): values of the surface or of the engine (`view-normal`, `view-depth`, `object-id` with the `id` of the items…), function graphs of the application, or values of the materials (`g.output`). Without `target`, only the outputs, without the shading models: a G-buffer. `addFullscreenPass(graph, name, { targets })` writes the `g.target` outputs of a full screen material.
- **Picking**: `pickIds(backend, texture, region)` reads back a point or a rectangle of an `r32uint` texture of `object-id` (created with the `copy-src` usage, given as the `target` of the output) and resolves with the identifiers in it, without blocking the frame loop.
- **Deferred rendering**: the shading models are functions (`lighting.phong`, `lighting.pbr`) that a full screen material can call on a G-buffer; `camera.positionFromDepth` rebuilds the world position from `view-depth` (with the `camera.inverseViewProjection` engine value). A full screen pass reads the camera and the lights of the last scene passes of the graph, and their shadow maps with `addFullscreenPass(graph, name, { shadows: scene.shadows })`.
- **Scene inputs**: `addScenePasses(graph, { inputs })` binds textures of the graph (a mirror image rendered by earlier passes) to the textures of that name of the materials drawn.
- **Tangents**: `computeTangents(mesh)` returns a copy of a mesh with a `tangent` attribute (float32x4, the bitangent up in the image), for normal and parallax mapping.
- **HDR**: when the backend can render to `rgba16float` (`backend.capabilities.renderableFormats`), `render()` draws the scene in linear colors into a transient HDR target, where transparent materials blend exactly, then a `tone mapping` full screen pass applies the exposure, the tone mapping and the encoding. `new Renderer(backend, { hdr: false })` applies them in each material instead, as without the capability.
- **Post-processing**: `renderer.addFullscreenPass(graph, name, { material, inputs, target, format })` draws a material whose graph ends with `output.fullscreen` over a target; `inputs` binds textures of the material to textures of the render graph (`{ source: scene }`), read with `builtin('screen-uv')`.
- **Shadows**: directional and spot lights with `castShadow: true` cast shadows. Their shadow maps share an atlas (`new Renderer(backend, { shadowAtlasSize })`, 2048 by default) drawn by a `<scene> shadows` pass before the scene, with the depth-only variant of the materials; the phong and pbr shading models read it with a filtered comparison (PCF). A directional light covers the bounds of the items (or `shadow.bounds`), a spot its cone. Items with `castShadow: false` and transparent items cast none; `addScenePasses(graph, { shadows: false })` turns them off. Point lights cast no shadows yet.
- **Multisampling**: `new Renderer(backend, { samples: 4 })` draws the scene into multisampled attachments, resolved into the target (the HDR texture or the surface).
- **Views**: each `addScenePasses` of a graph (by its `name`), each shadow map and each full screen pass has its own frame uniforms: several cameras can be drawn in one graph.
- **Render graph**: `RenderGraph` describes a frame as raster, compute and copy passes declaring the textures and buffers they read and write; `new RenderGraphRunner(backend).execute(graph)` culls the unused passes, orders the others, allocates the transient resources from a pool reused between frames and within a frame (a texture whose last pass is done serves a later one), and caches the compilation by structure. Multisampled textures (`sampleCount`) are resolved with `pass.resolveColor(texture)`; passes get the size of their textures with `context.size(handle)`; `graph.toDot()` describes the graph for Graphviz. See [design/render-graph.md](../../design/render-graph.md).
- **Compute**: `new ComputeRunner(backend).dispatch(program, { values, workgroups })` runs a compiled compute graph outside of rendering (values by name: uniforms, textures, samplers, storage buffers); results are read back with `buffer.read()`. `record(pass, program, dispatch)` records it in the compute pass of a render graph instead. Bind groups are cached by program and resources (LRU, `{ bindGroups: 256 }`).
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
