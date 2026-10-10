---
title: Extending the engine
description: Add a node, a shading model, a render feature or a backend.
sidebar:
  order: 6
---

Most extensions need no change to the engine: a function graph, a shading
model or a render pass is written in an application. This page goes from
those to the changes inside the engine.

## Without changing the engine

| To add                     | Write                                                        | See                                                            |
| -------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| A reusable piece of shader | A function graph, `defineFunction(graph, { id })`            | [Material graph](/fdw-engine/guides/material-graph/#functions) |
| A shading model            | A function graph, `defineShadingModel(name, graph)`          | [Tutorial](/fdw-engine/tutorials/custom-shading-model/)        |
| A post-processing effect   | A full screen material, `renderer.addFullscreenPass()`       | [Tutorial](/fdw-engine/tutorials/post-processing/)             |
| A pass                     | `graph.addRasterPass()`, `addComputePass()`, `addCopyPass()` | [Render graph](/fdw-engine/guides/render-graph/)               |
| A GPU computation          | A compute graph, `ComputeRunner`                             | [Compute](/fdw-engine/guides/compute/)                         |

A function or a model registered in a `NodeRegistry` is available to every
graph built with it; `build()` embeds it in the graphs that use it.

## A standard node

A function of the standard library that maps to a function of the shading
languages (an **intrinsic**) goes through every layer:

1. **The definition**, in `engine-shader/src/std/functions.ts`: its id, its
   ports and their types (generic or concrete), and its op.
2. **The op**, in `IntrinsicOp` (`graph/NodeDefinition.ts`) and
   `IrIntrinsic` (`compiler/ir.ts`).
3. **Constant folding**, if it applies, in `compiler/optimize.ts`.
4. **The code generators**, where the language names it differently: WGSL
   (`WgslCodegen`), GLSL ES (`GlslEsCodegen`), HLSL (`HlslCodegen`: `lerp`
   for `mix`, `frac` for `fract`…).
5. **The tests**: a compiler test, the generated code, and a pixel test in
   the rendering suite, which runs it on every backend and through DXC.

A node that can be written with other nodes is better as a **function
graph** in the standard library (`std/subgraphs.ts`, `std/color.ts`): no
change to the IR nor to the generators.

A **macro** (`std/macros.ts`) is evaluated at compile time: it reads static
parameters (`context.feature()`) and returns the nodes replacing it. Use one
for choices that must not cost anything at run time.

## A renderer feature

The `Renderer` is built on the render graph: a feature adds passes, or
values to the frame uniforms.

- **Frame values** (camera, lights, shadows) are declared in the layout of
  the `frame` slot (`engine-shader/src/compiler/layout.ts`) and written by
  the renderer; the graphs read them with `g.engine()` or `light.current`.
- **Engine resources** (the shadow atlas and its sampler) are bound in the
  frame group, only for the programs that use them.
- **Variants** of the materials (`shadows`, `depthOnly`, `toneMapping`) are
  features set by the renderer and read by the lowering of the compiler.

The design document of the render graph (`design/render-graph.md`) explains
the choices behind the shadows, the HDR target and the views.

## A backend

A backend implements the interfaces of `@fdw/engine-backend`:

- an `Engine` (device creation, lifecycle) and its `Surface`s;
- the factories: `GpuBufferFactory`, `GpuTextureFactory`,
  `GpuSamplerFactory`, `GpuPipelineFactory`;
- the command encoders (`GpuCommandEncoder`, render and compute passes);
- a `PrimitivesAdapter` for `TransformMath` and `CameraMath` (its clip
  space conventions);
- a `PhysicalLayoutStrategy` (bindings and uniform offsets) and a
  `ShaderCodegen` (the IR into its language);
- its `capabilities`.

Then:

1. add a fixture to `tests/rendering` and run the suite on it: it covers
   every feature of the engine, with expected pixels;
2. add its surfaces to `apps/demo` or `apps/demo-native`;
3. document it in [Backends and surfaces](/fdw-engine/guides/backends-and-surfaces/).

The WebGL2 backend is the best model for an API far from WebGPU (no bind
groups, no compute); the Vulkan backend for an explicit API (barriers,
command recording, native library).

## Before starting

A change that affects the design — a new concept, an API, a dependency —
starts with a design document. See [Design process](/fdw-engine/contributing/design-process/).
