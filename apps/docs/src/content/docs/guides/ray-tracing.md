---
title: Ray tracing
description: Rays traced in the scene — the acceleration structures of the backends (in hardware on Vulkan and Direct3D 12, in software on WebGPU), the traced scene, shadows, reflections and ambient occlusion by rays, the path tracer, and the rays in your own graphs.
sidebar:
  order: 20
---

The engine rasterizes by default; rays come on top, as an option of the
rendering, on the backends that can trace them. The same scene, the same
materials: only what draws the pixels changes. The tutorials show each
use: [shadows by rays](/fdw-engine/tutorials/ray-traced-shadows/),
[reflections and ambient occlusion](/fdw-engine/tutorials/ray-reflections/),
[the path tracer](/fdw-engine/tutorials/path-tracing/),
[animated and generated geometry](/fdw-engine/tutorials/ray-traced-characters/).

## The backends

| Backend     | Rays                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vulkan      | In hardware: `VK_KHR_acceleration_structure` and `VK_KHR_ray_query`, where the GPU has them (RTX, RDNA2 and later; lavapipe in software); the ray tracing pipelines (`VK_KHR_ray_tracing_pipeline`) as an option |
| Direct3D 12 | In hardware: DXR 1.1 (ray queries, Shader Model 6.5), where the GPU has it (RTX, RDNA2 and later); the ray tracing pipelines (state objects, `DispatchRays`) as an option                                        |
| WebGPU      | In software: a BVH built on the CPU, in storage buffers, traversed by WGSL code the backend adds to the programs that trace rays                                                                                 |
| WebGL2      | None: the rasterization only                                                                                                                                                                                     |

The capability `rayQuery` of the backend says whether it traces rays
(`backend.capabilities?.rayQuery`). Without it, `RayScene` and the passes
of rays throw: check it, and keep the rasterization (the examples of the
tutorials do).

## The traced scene

`RayScene` (`@fdw/engine-raytracing`) holds what rays see:

```ts
import { RayScene } from '@fdw/engine-raytracing';

const scene = new RayScene(backend);
// Each frame, before rendering:
scene.update({ source, items });
```

- **A bottom level per mesh**, built once (on the GPU in Vulkan and
  Direct3D 12, on the CPU in WebGPU: a binned SAH), kept while the mesh
  does not change.
- **The instances**, rewritten at each update: every item of the source
  (all of them, not only those the camera sees: rays look behind), each
  with its world matrix, its material and its mask (the transparent items
  and those with `castShadow: false` are not seen by the shadow rays).
- **The data of the hits**, in storage buffers shared by both backends:
  the instances (their matrices, their material, their object), the
  triangles and the vertices (position, normal, uv, tangent).

- **The alpha masks** of the masked materials, baked once (see below).

What the GPU moves is followed: the vertices of a skinned mesh
(`Material.deformedVertices`, set by the compute skinning) refit its
structure at each update; an item whose material makes its geometry in the
vertex stage (a terrain of patches) is traced with its `rayMesh`. Without
either, such an item is left out (the sea of the ocean). `filter` leaves
out other items. The [tutorial](/fdw-engine/tutorials/ray-traced-characters/)
shows both.

## Shadows by rays

```ts
renderer.render({ …, rays: { scene, shadows: true } });
renderer.render({ …, rays: { scene, shadows: { samples: 8 } } });
```

The materials trace, for each light casting shadows, a ray from the point
towards the light, instead of reading a shadow map: exact shadows, at any
distance, without acne nor texels. With `samples`, several rays across the
light (its `shadow.softness`: the radius of a spot, the tangent of the
angular radius of a sun) give soft shadows. The shadow maps are not drawn.

## The alpha of the masked materials

The rays go through the cut parts of the masked materials (`alphaMode:
'mask'`): the leaves, the fences. `RayScene` bakes the alpha of each
masked material over its uv (its hit program over a square, cut at its
cutoff, 256 × 256 bits in the geometry of the scene), again when its values
change; the traversals test the candidate triangles of the masked
instances against it (Vulkan, Direct3D 12: the non opaque instances in the
ray query loop, or an any-hit shader; WebGPU: in the WGSL traversal). In
your graphs, `g.traceRay({ …, alphaTest: true })` (`ray.traceAlpha`) does the same.

## Passes of rays

Over a G-buffer (the point, the normal, the base color of each pixel:
`reflectionOutputs()`, outputs of the scene passes):

- **`RayOcclusion`**: ambient occlusion, rays in the half sphere of each
  normal, blurred along the surfaces.
- **`RayReflections`**: the view direction mirrored by the normal, traced;
  the surfaces hit shaded with **their own materials**, lit by every light
  with traced shadows; added to the image by the Fresnel term, faded out
  with the roughness.

## The path tracer

`PathTracer` draws the whole image by rays: from the camera, then bounce
after bounce, gathering the light of the emissive surfaces, of the lights
(a shadow ray towards one of them at random) and of the sky. The frames add
up while nothing moves; an à-trous filter removes the noise of the first
ones.

```ts
const tracer = new PathTracer(renderer, scene, { bounces: 4 });
tracer.render({ camera, surface, lights });
```

It works in waves of compute passes: the rays of all the pixels in
buffers, traced together; the surfaces they hit evaluated material by
material; then a bounce kernel. One dispatch per material per bounce: the
cost grows with the number of materials of the scene.

When the camera or the scene moves, each pixel follows the point it saw:
the previous frame reprojected (the point and the normal of the first hit
kept), its history kept where it saw the same surface, at most `history`
frames (16) while things move; still, the frames add up without end.

## Ray tracing pipelines

On Vulkan and Direct3D 12, a compute program that traces rays can run as
the ray generation shader of a **ray tracing pipeline**
(`createComputePipeline({ program, rayTracing: true })`, the
`rayTracingPipeline` capability): a thread per ray, `TraceRay` with a
closest-hit shader writing the hit, a miss shader, and the alpha test in an
any-hit shader. The same graphs, the same results (a test compares them to
the bit); `ComputeRunner`, `PathTracer` and `RayReflections` take the
option (`rayTracingPipeline: true`). Elsewhere, the ray queries. The
surfaces of the materials stay dispatches of their hit programs: hit
groups per material would bind the resources of every material at once.

## In the editor

The viewport of the level draws with rays from the menu Edit › Rendering
(or the palette): the traced shadows, the reflections, the path tracer —
on Vulkan (the desktop editor) and WebGPU (the web editor); WebGL2 keeps
the rasterization. The picking and the gizmos stay those of the
rasterization.

## The surfaces at the points hit

A material is written once: the compiler also compiles its surface for
the points hit by rays (`compile(graph, { target: 'hit' })`):

- its attributes interpolated at the point hit (position, normal, uv,
  tangent), its object matrices those of the instance hit;
- its textures read at their first level (no derivatives), its
  derivatives 0 (a normal that cannot be computed then is replaced by the
  normal of the vertices);
- the attributes its vertex stage computes (`g.vertexAttribute`) are those
  of the geometry traced;
- what it gives: the base color and the alpha, the normal, the roughness
  and the metalness, the emission — the parameters of the BSDF of the
  `pbr` model (Lambert and GGX) the passes of rays use. `phong` gives a
  roughness of the same lobe; `unlit` is emission.

A material that has no surface there (raw stages) is drawn gray, with a
warning.

## Rays in your graphs

`g.traceRay({ origin, direction, tMin, tMax, mask, mode })` traces a ray in
the scene of the frame (`input.engine('scene')`), in any stage. Its hit, a
`vec4<u32>`, is read with the functions of `stdRays`:

| Function                                     | Gives                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| `hit`                                        | Whether the ray hit something                          |
| `hitPosition`, `hitNormal`                   | The point hit, its normal (interpolated), in the world |
| `hitGeometricNormal`, `hitFrontFacing`       | The normal of the triangle, the face hit               |
| `hitUv`, `hitLocalTangent`                   | The uv, the tangent of the vertices                    |
| `hitObject`, `hitMaterial`, `hitData`        | The object (its `id`), the material, the user vec4     |
| `hitBarycentrics`, `hitVertices`, `hitWorld` | The weights of the vertices, their indices, the matrix |

`mode: 'any'` stops at the first hit (shadows, occlusion). The materials
drawn by the renderer get the scene with `rays`; a full screen pass with
`addFullscreenPass(…, { rays: scene })`; a compute graph through the values
of its dispatch (`scene.resource(name)`).

## Costs

1280 × 720 on an RTX 2060 SUPER, without vsync (the TPS: its characters,
its terrain and its foliage in the scene of the rays):

| Demo | Backend                       | Rasterized | Traced shadows | + reflections | Path tracer |
| ---- | ----------------------------- | ---------- | -------------- | ------------- | ----------- |
| FPS  | Vulkan                        | 1170 fps   | 576 fps        | 275 fps       | 89 fps      |
| FPS  | Vulkan, ray tracing pipelines |            |                | 305 fps       | 90 fps      |
| FPS  | WebGPU (Dawn)                 | 560 fps    | 131 fps        | 68 fps        | 33 fps      |
| TPS  | Vulkan                        | 81 fps     | 39 fps         | 37 fps        | 27 fps      |
| TPS  | Vulkan, ray tracing pipelines |            |                | 41 fps        | 34 fps      |
| TPS  | WebGPU (Dawn)                 | 58 fps     | 7 fps          | 5 fps         | 4 fps       |

In WebGPU, the software traversal costs more, and more as the scene grows:
traced shadows suit small scenes; the path tracer gathers its frames
slower. In the forest of the TPS, the top level rebuilt on the CPU each
frame weighs too.

## Not yet

- A BVH built on the GPU (the top level of large scenes costs on the CPU
  each frame), BVHs of 4 or 8 children.
- The variance in the temporal filter (SVGF), ReSTIR, importance sampling
  of environment maps.
- The sea of the ocean in the scene of the rays.
