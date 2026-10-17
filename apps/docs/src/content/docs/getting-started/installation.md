---
title: Installation
description: Set up the workspace, run the demos, and create an application on the engine.
sidebar:
  order: 2
---

The engine is developed in an [Nx](https://nx.dev) monorepo, with npm
workspaces. Its packages are not published yet: an application lives in the
workspace, next to them.

## Prerequisites

- **Node.js 20 or later** (24 recommended) and npm.
- **A browser**: a WebGPU one (recent Chrome or Edge, Firefox Nightly,
  Safari Technology Preview), or any WebGL2 browser: compute is emulated
  there, without indirect dispatches.
- For the native backends only: CMake, a C/C++20 compiler and, for Vulkan,
  the Vulkan SDK. See [Native window](/fdw-engine/getting-started/native/).

## Get the workspace

```sh
git clone https://github.com/benjamin-fukdawurld/fdw-engine.git
cd fdw-engine
npm install
```

Check that everything builds and passes:

```sh
npx nx run-many -t typecheck lint test
```

## Run the demos

The browser demo is a series of examples, from a first triangle to PBR and
shadows:

```sh
npx nx serve demo        # http://localhost:4200
```

Its `material-graph`, `loading-model`, `pbr` and `shadows` routes run on
both browser backends: switch with the buttons of the header, or with
`?backend=webgl2`.

This documentation is an application of the workspace too:

```sh
npx nx run docs:dev      # http://localhost:4321/fdw-engine/
```

## Create an application

An application is a folder of `apps/` with a `package.json` declaring the
packages it uses:

```json title="apps/my-app/package.json"
{
  "name": "@fdw-engine/my-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@fdw/engine-backend": "0.0.1",
    "@fdw/engine-core": "0.0.1",
    "@fdw/engine-shader": "0.0.1",
    "@fdw/engine-webgl2": "0.0.1",
    "@fdw/engine-webgpu": "0.0.1"
  }
}
```

After `npm install`, the packages are links to `packages/*`. They export their
TypeScript sources: build the application with a bundler that compiles
TypeScript, such as [Vite](https://vite.dev), which `apps/demo` uses.

```ts title="apps/my-app/src/main.ts"
import { Renderer } from '@fdw/engine-core';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

const engine = new WebGpuEngine();
await engine.init();
// …
```

Then run `npx nx sync`: Nx adds the TypeScript project references of the
dependencies, so that `npx nx run my-app:typecheck` checks the application
with the packages.

The packages to depend on:

| Package              | For                                                       |
| -------------------- | --------------------------------------------------------- |
| `@fdw/engine-core`   | Cameras, transforms, lights, meshes, materials, rendering |
| `@fdw/engine-shader` | Material graphs and compute graphs                        |
| `@fdw/engine-webgpu` | WebGPU, in the browser or on Dawn                         |
| `@fdw/engine-webgl2` | WebGL2, for browsers without WebGPU                       |
| `@fdw/engine-native` | Native windows in Node, Dawn                              |
| `@fdw/engine-vulkan` | Vulkan in Node                                            |

`@fdw/engine-backend` holds the interfaces shared by the backends
(`Engine`, `Surface`, `RenderBackend`) and the math types: depend on it as
soon as you write code that does not care which backend it runs on.

## Next

[Your first scene](/fdw-engine/getting-started/first-scene/) draws a lit cube,
step by step.
