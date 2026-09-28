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
        ┌─────────────────┼─────────────────┬──────────────┐
        │                 │                 │              │
┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────┐
│ engine-webgpu │ │ engine-vulkan │ │ engine-dx12  │ │ engine-  │
│ (in progress) │ │   (planned)   │ │  (planned)   │ │  metal…  │
└───────────────┘ └───────────────┘ └──────────────┘ └──────────┘
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

| Backend              | Technology | Windowing           | Status      |
| -------------------- | ---------- | ------------------- | ----------- |
| `@fdw/engine-webgpu` | WebGPU     | Browser (canvas)    | In progress |
| `@fdw/engine-vulkan` | Vulkan     | Native (e.g. SDL)   | Planned     |
| —                    | DirectX 12 | Native              | Planned     |
| —                    | Metal      | Native              | Planned     |

The WebGPU backend provides `WebGpuEngine`, `WebGpuSurface`, the GPU implementations, and a WGSL shader generator based on [Eta](https://eta.js.org/) templates (Phong lighting model).

## Roadmap

1. **v1 — WebGPU / browser**: first complete backend, rendering into a `<canvas>`.
2. **Windowing abstraction**: decouple `Surface` from the browser canvas to support other windowing systems.
3. **Native backends**: Vulkan in a native window (SDL), then possibly DirectX and Metal.

## Repository layout

```
apps/
  demo/                 React + Vite demo application (WebGPU)
packages/
  engine-core/          Frontend: scene manipulation API
  engine-backend/       Abstract API
  engine-webgpu/        WebGPU backend
```

The monorepo is managed with [Nx](https://nx.dev).

## Getting started

### Prerequisites

- Node.js ≥ 20
- A WebGPU-capable browser (recent Chrome / Edge, Firefox Nightly, Safari Technology Preview…)

### Install

```sh
npm install
```

### Run the demo

```sh
npm run serve
```

The demo contains a series of progressive examples (triangle, vertex/index buffers, uniforms, matrices, camera, textures, depth testing, face culling, OBJ/MTL model loading…) in [apps/demo/src/routes](apps/demo/src/routes).

### Build the packages

```sh
npm run build
```

### Generate the documentation

```sh
npm run docs
```

Documentation is generated with [TypeDoc](https://typedoc.org/) for each engine package.

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
