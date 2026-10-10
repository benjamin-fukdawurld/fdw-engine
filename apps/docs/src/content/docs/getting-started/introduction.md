---
title: Introduction
description: What FdwEngine is, what it does, and how this documentation is organized.
sidebar:
  order: 1
---

FdwEngine is a 3D engine written in TypeScript. The same application code
renders in the browser, with **WebGPU** or **WebGL2**, and in a native window,
with **WebGPU (Dawn)** or **Vulkan 1.3**. Scenes, materials and render passes
are written once; only the choice of the backend depends on the platform.

:::caution[Work in progress]
The engine is young and its APIs still change. It is not published on npm
yet: applications are built inside the monorepo (see
[Installation](/fdw-engine/getting-started/installation/)).
:::

## What it does

- **Materials as graphs.** A material is a graph of typed nodes, checked as
  it is built, compiled to WGSL, GLSL ES or HLSL for each backend. Its values
  (colors, textures) change without recompiling anything; its static
  parameters select variants of the program.
- **Shading models.** Unlit, Phong and PBR (metallic/roughness, as in glTF)
  come with the engine. A custom model is a graph too.
- **Lights and shadows.** Directional, point and spot lights; shadow maps
  for directional and spot lights, in an atlas, filtered (PCF).
- **Colors and HDR.** Linear colors, sRGB textures, an HDR target with tone
  mapping (Reinhard, ACES, Khronos PBR Neutral), multisampling.
- **Render graph.** A frame is a graph of passes declaring what they read
  and write: the engine orders them, culls the unused ones, allocates and
  reuses their textures, and inserts the barriers on Vulkan.
  Post-processing effects are materials drawn over the screen.
- **Compute.** Compute graphs, written with the same nodes, run on the GPU
  and write storage buffers (WebGPU, Vulkan).
- **Native.** Windows (SDL3) and a render loop for Node, presenting WebGPU
  frames from Dawn, or Vulkan frames through a swapchain.

## The layers

```
Application
    │
@fdw/engine-core      Scene objects, materials, Renderer, render graph
    │
@fdw/engine-backend   The abstract API: engine, surface, GPU resources, commands
    │
@fdw/engine-webgpu · @fdw/engine-webgl2 · @fdw/engine-vulkan
```

`@fdw/engine-shader`, the material graph and its compiler, is used by every
layer and depends on none: it is pure TypeScript. `@fdw/engine-native` gives
the native windows and surfaces.

An application talks to `@fdw/engine-core` and `@fdw/engine-shader`, and
picks a backend once, at startup. The [Architecture](/fdw-engine/contributing/architecture/)
page goes into the details.

## This documentation

- **Getting started**: install the workspace, render a first scene, run it
  in a native window.
- **Tutorials**: one feature at a time, each with a live example. The code
  shown under an example is the code that runs it.
- **Guides**: how each part of the engine works, and its options.
- **Contributing**: the workspace, the conventions, the tests, and how to
  extend the engine.
- **API reference**: generated from the comments of the sources.

The live examples use WebGPU when your browser has it, WebGL2 otherwise. Add
`?backend=webgl2` to the address of a page to force WebGL2.
