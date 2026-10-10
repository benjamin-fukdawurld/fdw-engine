---
title: Architecture
description: The packages of the engine, their dependencies, and the path of a frame through them.
sidebar:
  order: 1
---

## The packages

```
                     engine-shader            material graph, compiler, IR
                          ▲
        ┌─────────────────┼───────────────────┐
        │                 │                   │
  engine-backend ◄── engine-core          (codegens)
        ▲                                     │
        ├──────────────┬──────────────┬───────┘
  engine-webgpu   engine-webgl2   engine-vulkan
        ▲                              ▲
        └────────── engine-native ─────┘
```

| Package          | Content                                                                                               | Depends on                        |
| ---------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| `engine-shader`  | Types, graph model, standard library, validation, compiler to an IR                                   | nothing                           |
| `engine-backend` | The abstract API: `Engine`, `Surface`, `RenderBackend`, GPU resources, math, layouts, `ShaderCodegen` | `engine-shader` (types)           |
| `engine-core`    | Scene objects, `Material`, `Mesh`, `Renderer`, `RenderGraph`, `ComputeRunner`                         | `engine-backend`, `engine-shader` |
| `engine-webgpu`  | WebGPU backend, `WgslCodegen`                                                                         | `engine-backend`                  |
| `engine-webgl2`  | WebGL2 backend, `GlslEsCodegen`                                                                       | `engine-backend`                  |
| `engine-vulkan`  | Vulkan backend (Node addon), `HlslCodegen`                                                            | `engine-backend`                  |
| `engine-native`  | Native windows, the loop, Dawn and Vulkan window surfaces (Node addon)                                | `engine-webgpu`, `engine-vulkan`  |
| `demo-scenes`    | Scenes and meshes shared by the demos                                                                 | `engine-core`                     |

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

1. **Graph.** The renderer builds a render graph: the image of the surface,
   a shadow pass if lights cast shadows, the opaque and transparent passes,
   and the tone mapping pass on HDR backends.
2. **Preparation.** For each item, the renderer finds its **program**
   (compiled once per graph, features, mesh attributes) and its **pipeline**
   (once per program, vertex layout, render state, target formats), and
   updates the GPU buffers whose version changed: the mesh, the `object`
   uniforms (transform), the `material` uniforms. The `frame` uniforms
   (camera, time, lights) are written once per view.
3. **Compilation.** The runner compiles the graph, or finds it in its cache:
   order, culling, lifetimes, transitions.
4. **Recording.** In one command encoder, each pass: transient resources
   from the pool, the pass encoder, its `execute` (the draws, sorted by
   pipeline and material, transparent ones back to front).
5. **Submission** and `surface.present()`.

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
