---
title: Architecture
description: The packages of the engine, their dependencies, and the path of a frame through them.
sidebar:
  order: 1
---

## The packages

```
engine-scene    ──► engine-core, engine-geometry
engine-core     ──► engine-backend, engine-shader, engine-geometry
engine-webgpu   ─┐
engine-webgl2   ─┼► engine-backend ──► engine-shader
engine-vulkan   ─┘
engine-native   ──► engine-webgpu, engine-vulkan
engine-shader, engine-geometry: no dependency
```

| Package           | Content                                                                                                                 | Depends on                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `engine-geometry` | Volumes, intersections (GJK), rays, spatial indices (octree)                                                            | nothing                                              |
| `engine-shader`   | Types, graph model, standard library, validation, compiler to an IR                                                     | nothing                                              |
| `engine-backend`  | The abstract API: `Engine`, `Surface`, `RenderBackend`, GPU resources, math, layouts, `ShaderCodegen`                   | `engine-shader` (types)                              |
| `engine-core`     | Scene objects, `Transform` and its pool, `Material`, `Mesh`, `Renderer`, `RenderSource`, `RenderGraph`, `ComputeRunner` | `engine-backend`, `engine-shader`, `engine-geometry` |
| `engine-webgpu`   | WebGPU backend, `WgslCodegen`                                                                                           | `engine-backend`                                     |
| `engine-webgl2`   | WebGL2 backend, `GlslEsCodegen`                                                                                         | `engine-backend`                                     |
| `engine-vulkan`   | Vulkan backend (Node addon), `HlslCodegen`                                                                              | `engine-backend`                                     |
| `engine-native`   | Native windows, the loop, Dawn and Vulkan window surfaces (Node addon)                                                  | `engine-webgpu`, `engine-vulkan`                     |
| `engine-scene`    | The scene: an ECS core, nodes, a transform pool, octrees; a `RenderSource`                                              | `engine-core`, `engine-geometry`                     |
| `demo-scenes`     | Scenes and meshes shared by the demos                                                                                   | `engine-core`                                        |

The rules:

- **engine-shader knows no GPU.** It produces a program — IR and logical
  layout — and stops there. It runs anywhere: in tests, in tools, in a
  worker.
- **engine-core knows no backend.** It talks to the `RenderBackend`
  interface only. A feature that needs a backend extends the abstract API
  first.
- **A backend knows no scene.** It creates resources, pipelines and
  commands; it does not know what a light or a material is.

## The path of a frame

`renderer.render({ items, camera, surface, lights })`:

1. **Culling.** The renderer asks its source (a scene, or a list of items)
   what is in the frustum of the camera, keeps the lights that reach it,
   then asks again for the casters of each shadow map.
2. **Graph.** It builds a render graph: the image of the surface, a shadow
   pass if lights cast shadows, the opaque and transparent passes, and the
   tone mapping pass on HDR backends.
3. **Preparation.** For each item, the renderer finds its **program**
   (compiled once per graph, features, mesh attributes) and its **pipeline**
   (once per program, vertex layout, render state, target formats), and
   updates the GPU buffers whose version changed: the mesh, the `object`
   uniforms (copied from the block of the transform in its pool), the
   `material` uniforms. The `frame` uniforms
   (camera, time, lights) are written once per view.
4. **Compilation.** The runner compiles the graph, or finds it in its cache:
   order, culling, lifetimes, transitions.
5. **Recording.** In one command encoder, each pass: transient resources
   from the pool, the pass encoder, its `execute` (the draws, sorted by
   pipeline and material, transparent ones back to front).
6. **Submission** and `surface.present()`.

## From graph to shader

```
GraphBuilder ─► MaterialGraphData ─► compile() ─► CompiledProgram ─► PhysicalLayoutStrategy ─► ShaderCodegen ─► WGSL / GLSL / HLSL
   (TS API)       (JSON)            (engine-shader)   (IR + layout)      (backend: bindings)       (backend)
```

The compiler lowers the outputs, expands the macros and functions,
optimizes, assigns each value to a stage, lays out the resources by slot,
and emits the IR: typed SSA instructions, one list per entry point, with
`loop-sum` the only control flow (the loop over the lights). The backends
resolve the layout into bindings and offsets following their rules (WGSL,
std140), then translate the IR.

## Versions and caches

Scene objects store their values in a single `ArrayBuffer` and increment a
**version** on every change; the renderer compares versions to update only
what changed. Programs are keyed by a hash of the optimized graph and its
variant parameters; pipelines by program and state; render graph
compilations by structure. A steady frame compiles nothing and allocates
nothing.

## The design documents

`design/` holds the design of each part, in French:
`material-graph.md`, `compute-graph.md`, `render-graph.md`,
`native-backends.md`, the follow-ups in `backlog.md` and the longer-term
directions in `evolutions.md`. See [Design process](/fdw-engine/contributing/design-process/).
