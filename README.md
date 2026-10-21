# FdwEngine

A multi-layer 3D engine written in TypeScript.

The goal is to cleanly separate **3D scene manipulation** from **the underlying rendering technology**, so that the same application can run on WebGPU in the browser today, and on Vulkan, DirectX or Metal in a native window tomorrow.

> 🚧 Work in progress — APIs may change at any time.

## Architecture

The engine is organized in three layers:

```
┌──────────────────────────────────────────────────────────┐
│  Application (e.g. apps/demo)                            │
└──────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────┐
│  Frontend — @fdw/engine-core                             │
│  Scene, cameras, transforms, lights, materials…          │
│  No dependency on any graphics API.                      │
└──────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────┐
│  Abstract API — @fdw/engine-backend                      │
│  Contracts (interfaces) between frontend and backends    │
│  Engine, Surface, GPU (buffers, textures, layouts…),     │
│  math, camera, transform, mesh, material, light          │
└──────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┬────────────────┬──────────────┐
        │                 │                 │                │              │
┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────┐
│ engine-webgpu │ │ engine-webgl2 │ │ engine-vulkan │ │ engine-dx12  │ │ engine-  │
│ (in progress) │ │ (in progress) │ │ (in progress) │ │  (planned)   │ │  metal…  │
└───────────────┘ └───────────────┘ └───────────────┘ └──────────────┘ └──────────┘
```

### 1. Frontend — `@fdw/engine-core`

High-level API for engine users. It lets you build and manipulate a 3D scene (cameras, transforms, directional / point / spot lights, …) **without caring about the rendering technology**. The frontend depends only on the abstract API.

### 2. Abstract API — `@fdw/engine-backend`

The contract layer between the frontend and the backends. It defines:

- the engine lifecycle (`Engine`: `init`, `pause`, `resume`, `destroy`) and the render surface (`Surface`);
- GPU abstractions (buffers, textures, samplers, layouts, data structs and serializers);
- math primitives (`vec2/3/4`, `mat3/4`, `quat`) and shared types (camera, transform, mesh, material, light).

No graphics-API-specific code belongs in this layer.

### 3. Concrete backends — `@fdw/engine-<tech>`

Each backend implements the abstract API for a given graphics technology and windowing system.

| Backend              | Technology                 | Windowing        | Status      |
| -------------------- | -------------------------- | ---------------- | ----------- |
| `@fdw/engine-webgpu` | WebGPU                     | Browser (canvas) | In progress |
| `@fdw/engine-webgl2` | WebGL2                     | Browser (canvas) | In progress |
| `@fdw/engine-native` | WebGPU (Dawn), then Vulkan | Native (SDL3)    | In progress |
| `@fdw/engine-vulkan` | Vulkan                     | Native (SDL3)    | In progress |
| —                    | DirectX 12                 | Native           | Planned     |
| —                    | Metal                      | Native           | Planned     |

The WebGPU backend provides `WebGpuEngine`, `WebGpuSurface` / `WebGpuOffscreenSurface`, the GPU implementations, and `WgslCodegen`, which generates WGSL from the programs compiled by `@fdw/engine-shader`. The WebGL2 backend provides the same for browsers without WebGPU, with `GlslEsCodegen` generating GLSL ES 3.00 from the same programs.

### Material graph — `@fdw/engine-shader` (in progress)

Materials are being redesigned as a backend-agnostic graph of typed nodes, compiled to shaders and render pipelines for each backend. The `@fdw/engine-shader` package provides the type system, the graph model, the standard node library, validation and the compiler (graph → IR + resource layout); `@fdw/engine-webgpu` and `@fdw/engine-webgl2` generate WGSL and GLSL ES from it, and `@fdw/engine-core` provides the runtime (`Material`, `Mesh`, `Renderer`) on top of an abstract `RenderBackend`. Shading models (unlit, Phong) and variants are macros of the graph. See the `material-graph` and `loading-model` routes of the demo, which run on both backends (buttons in the header, or `?backend=webgl2`). See the [design proposal](design/material-graph.md) (in French).

## Roadmap

1. **v1 — WebGPU / browser**: first complete backend, rendering into a `<canvas>`.
2. **Windowing abstraction**: decouple `Surface` from the browser canvas to support other windowing systems.
3. **Native backends**: Vulkan in a native window (SDL), then possibly DirectX and Metal.

## Repository layout

```
apps/
  demo/                 React + Vite demo application (WebGPU, WebGL2)
  demo-native/          The scenes of the demo in a native window (Node, Dawn, Vulkan)
  docs/                 The developer documentation (Astro, Starlight): tutorials, guides, API
packages/
  engine-core/          Frontend: scene manipulation API
  engine-backend/       Abstract API
  engine-webgpu/        WebGPU backend
  engine-webgl2/        WebGL2 backend
  engine-shader/        Material graph: shader types, graph model, compiler
  engine-geometry/      Volumes, intersections, rays, spatial indices (octree)
  engine-scene/         The scene: an ECS core, nodes, transforms, culling
  engine-occlusion/     Occlusion culling: a depth pyramid tested on the GPU, every backend
  engine-tessellation/  Tessellation: patches drawn from templates at their level, every backend
  engine-input/         Input: keyboard, pointer, gamepads, named actions with rebindable controls
  engine-input-web/     The input source of a page (DOM events, Gamepad API)
  engine-input-native/  The input source of a native window (SDL3)
  engine-camera/        Camera operators (orbit, fly, walk) driven by the actions of the input
  engine-behavior/      Behavior graphs: events, a flow of execution, run as systems, interpreted or compiled, a debugger
  engine-noise/         The noises of the material graph in TypeScript (heights, placement), the same bits as the GPU
  engine-editing/       Editing tools: selection and outlines, transform gizmos, undoable commands, scene events
  engine-physics/       Physics: an abstract API, the bodies as components of the scene, a debug view
  engine-physics-rapier/ The physics API on Rapier (WebAssembly, in the browser and in Node)
  engine-ocean/         The sea: an ocean spectrum by FFT on the GPU or Gerstner waves, the water seen through, buoyancy
  engine-native/        Native windows and surfaces (Node-API addon over SDL3)
  engine-vulkan/        Vulkan backend (Node-API addon, HLSL compiled to SPIR-V by DXC)
  demo-scenes/          Scenes shared by the web and native demos
tests/
  rendering/            Rendering tests shared by the backends (Dawn in Node, WebGL2 in headless Chromium)
design/                 Design proposals
```

The monorepo is managed with [Nx](https://nx.dev).

## Getting started

### Prerequisites

- Node.js ≥ 20
- A WebGPU-capable browser (recent Chrome / Edge, Firefox Nightly, Safari Technology Preview…), or any WebGL2 browser for the routes built on the engine API
- For the WebGL2 rendering tests: the Playwright Chromium headless shell (`npx playwright install chromium-headless-shell`)

### Install

```sh
npm install
```

### Run the demo

```sh
npm run serve
```

The demo contains a series of progressive examples (triangle, vertex/index buffers, uniforms, matrices, camera, textures, depth testing, face culling, OBJ/MTL model loading…) in [apps/demo/src/routes](apps/demo/src/routes).

### Run the native demo

The scenes of the demo in a native window, outside of the browser (Linux for now; needs CMake and a C/C++ compiler, and fetches SDL3 on the first build):

```sh
npx nx run demo-native:start -- shadows            # or pbr, on WebGPU (Dawn); Escape quits
npx nx run demo-native:start -- shadows --vulkan   # on Vulkan: needs the Vulkan SDK (source its setup-env.sh)
```

### Build the packages

```sh
npm run build
```

### Run the tests

```sh
npm test
```

Tests use [Vitest](https://vitest.dev/). Each package has its own `vitest.config.mts`, and test files are `src/**/*.spec.ts` or `src/**/*.test.ts`. To test a single package, run `npx nx test engine-shader`, or `npx vitest --watch` from the package directory for watch mode.

### Read the documentation

```sh
npx nx run docs:dev      # http://localhost:4321/fdw-engine/
```

The developer documentation, in English and French: getting started, tutorials with live examples, guides, contributing, and the API reference generated from the sources with [TypeDoc](https://typedoc.org/). `npx nx run docs:build` builds the static site into `apps/docs/dist`.

## Usage example

```ts
import { Engine } from '@fdw/engine-backend';
import { WebGpuEngine } from '@fdw/engine-webgpu';

// Only the backend choice depends on the rendering technology.
const engine: Engine = new WebGpuEngine();
await engine.init();

// … build the scene with @fdw/engine-core …

await engine.destroy();
```

## License

MIT
