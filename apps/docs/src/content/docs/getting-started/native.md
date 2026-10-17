---
title: Native window
description: Run a scene outside of the browser, in Node, on WebGPU (Dawn) or Vulkan.
sidebar:
  order: 4
---

The scenes of the browser run in a native window too, in Node: the
materials, meshes and renderer are the same; the engine, the window and the
surface change. Linux is supported for now; the native code is written to be
portable (CMake, C++20, SDL3, Node-API).

## Two backends

| Backend        | Engine                                      | Surface               | Presentation                                                     |
| -------------- | ------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| WebGPU on Dawn | `createDawnEngine()` (`@fdw/engine-native`) | `DawnWindowSurface`   | By copy: rendered into a texture, read back, shown by the window |
| Vulkan 1.3     | `VulkanEngine` (`@fdw/engine-vulkan`)       | `VulkanWindowSurface` | A swapchain, without copy                                        |

Dawn is the simplest way to start: it needs no SDK. Its copy costs a frame
or two of latency, fine for tools and development. Vulkan presents directly,
and runs the engine without WebGPU in between.

## Build the native addons

The windows come from a Node addon over SDL3, built with CMake. You need
CMake and a C/C++20 compiler; SDL3 is downloaded on the first build.

```sh
npx nx run engine-native:build-native
```

For Vulkan, install the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home)
(headers, volk, VMA, the DXC shader compiler and the validation layer), set
up its environment, then build the Vulkan addon:

```sh
source <sdk>/setup-env.sh                 # sets VULKAN_SDK
npx nx run engine-vulkan:build-native
```

Without `VULKAN_SDK`, the Vulkan addon is not built, and the Vulkan tests are
skipped. [Native builds](/fdw-engine/contributing/native-builds/) gives the
details.

## Run the native demo

`apps/demo-native` runs the scenes of the demo (`shadows`, `pbr`, `maze`,
`fps`, `city`, `terrain`, `physics`: the physics playground, on Rapier):

```sh
npx nx run demo-native:start -- shadows              # WebGPU on Dawn
npx nx run demo-native:start -- shadows --vulkan     # Vulkan
```

Its options:

| Option         | Effect                                                         |
| -------------- | -------------------------------------------------------------- |
| `--vulkan`     | Vulkan instead of Dawn                                         |
| `--validation` | The Khronos validation layer (Vulkan), its messages at the end |
| `--no-vsync`   | Renders as fast as possible, to measure                        |
| `--frames <n>` | Stops after `n` frames                                         |
| `--hidden`     | Hides the window (tests)                                       |

Escape or closing the window quits. The title shows the frame rate.

## In your application

A scene written for the browser runs unchanged; only its setup differs.
On Dawn:

```ts
import {
  createDawnEngine,
  DawnWindowSurface,
  NativeWindow,
  runLoop,
} from '@fdw/engine-native';
import { Renderer } from '@fdw/engine-core';

const engine = await createDawnEngine();
const window = new NativeWindow({ title: 'My app', width: 1280, height: 720 });
const surface = new DawnWindowSurface(window);
await surface.init(engine);
const renderer = new Renderer(engine.backend!);

// runLoop replaces requestAnimationFrame: it dispatches the window events,
// calls the frame, and lets the Node event loop run.
const loop = runLoop(
  (now) => renderer.render({ items, camera, surface, time: now / 1000 }),
  // At most two frames in flight.
  { throttle: () => surface.throttle() },
);
window.addEventListener('close', () => loop.stop());
await loop.done;

surface.destroy();
window.destroy();
await engine.destroy();
```

On Vulkan, the engine and the surface change, and the window is created for
Vulkan:

```ts
import { NativeWindow, runLoop, VulkanWindowSurface } from '@fdw/engine-native';
import { VulkanEngine } from '@fdw/engine-vulkan';

const engine = new VulkanEngine({ validation: true });
await engine.init();
const window = new NativeWindow({
  title: 'My app',
  width: 1280,
  height: 720,
  vulkan: true,
});
const surface = new VulkanWindowSurface(window, { vsync: true });
await surface.init(engine);

// The swapchain sets the pace: no throttle.
const loop = runLoop((now) => renderer.render({ items, camera, surface }));
```

The window gives its events as DOM events: `resize`, `keydown` / `keyup`,
`pointermove`, `pointerdown`, `pointerup`, `wheel`, `close`. Its `width` and
`height` follow its size in pixels, and the surface follows the window.

Run the TypeScript sources with a loader such as
[jiti](https://github.com/unjs/jiti): `node --import jiti/register main.ts`.
The [Native guide](/fdw-engine/guides/native/) explains how the two
presentations work.
