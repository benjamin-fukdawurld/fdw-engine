---
title: Troubleshooting
description: The usual problems when installing, building and running the engine, and their fixes.
sidebar:
  order: 5
---

## In the browser

### WebGPU is not available

`WebGpuEngine.init()` throws `WebGPU is not supported in this environment`
when the browser has no `navigator.gpu`, and `Failed to get GPU adapter` when
it has no usable GPU. Fall back to WebGL2, as
[Your first scene](/fdw-engine/getting-started/first-scene/#as-an-application)
does.

- Chrome and Edge have WebGPU on Windows, macOS and ChromeOS. On Linux, it
  may need `chrome://flags/#enable-unsafe-webgpu` and the Vulkan backend
  (`chrome://flags/#enable-vulkan`).
- Firefox has it in its recent versions on Windows, and in Nightly
  elsewhere; Safari in its recent versions.
- `chrome://gpu` tells whether WebGPU is enabled, and why not.

The live examples of this site do the same: they say which backend they run
on under the canvas. Add `?backend=webgl2` to force WebGL2.

### "the backend has no compute shaders"

A compute graph compiled with the capabilities of a backend without compute
(`capabilities.compute === false`). The backends of the engine all have it,
WebGL2 by rendering to textures: check the capabilities given to `compile`.

### Nothing is drawn

- **No light**: `phong` and `pbr` need lights. Without any, only `emissive`
  shows. Try `unlit` first.
- **The camera** looks down its −z axis: an object at the origin is seen
  from `position: { z: 5 }`.
- **Back faces** are culled: triangles must be counter-clockwise seen from
  outside, or the material `doubleSided`.
- **The surface size** follows the canvas attributes `width` and `height`,
  not its CSS size: set them, and the `aspect` of the camera.
- **A pipeline still compiling**, with `asyncPipelines: true`: the item is
  skipped until it is ready; `await renderer.whenReady()`.

### A graph throws as it is built

`GraphError` names the node and the port at fault:

```
error: #n3.b: std.mul: got vec4<f32>, incompatible with vec3<f32> connected to "a"
```

Swizzle the value (`.swizzle('rgb')`), or convert it (`std.extend`,
`std.convert`, `std.vec3`). The only implicit conversion is from a scalar to
a vector.

## In the workspace

### "does not provide an export named …"

The Vite dev server (`demo` or `docs`) serves a stale version of a package
after its exports changed. Restart the server.

### "The workspace is out of sync"

The TypeScript references no longer match the `package.json` dependencies:

```sh
npx nx sync
```

### A lint error on an import

`@nx/enforce-module-boundaries`: a project imports another one by a relative
path, or without declaring it. Import it by its package name
(`@fdw/engine-core`), and add it to the `dependencies` of the
`package.json`.

## Native

### "The native addon of @fdw/engine-native is not built"

```sh
npx nx run engine-native:build-native
```

It needs CMake 3.24 or later and a C/C++20 compiler. The first build
downloads SDL3: it needs the network.

### "node_api.h not found"

The build found no Node-API headers next to the Node it runs with — the
`node` binary that Nx uses comes without them. Install Node with its headers
(nvm, the official packages), or point `NODE_API_INCLUDE_DIR` to a directory
holding `node_api.h`.

### "VULKAN_SDK is not set"

The Vulkan addon is not built, and the Vulkan tests are skipped. Install the
[Vulkan SDK](https://vulkan.lunarg.com/sdk/home), then source its
environment in the shell that builds, tests or runs:

```sh
source ~/vulkan/<version>/setup-env.sh
```

### The shaders do not compile on Vulkan

The Vulkan backend loads DXC (`libdxcompiler`) at run time, from
`FDW_DXC_LIBRARY`, then from the SDK (`VULKAN_SDK`), then from the system.
Source the SDK environment, or set `FDW_DXC_LIBRARY`.

### The validation layer reports nothing

`new VulkanEngine({ validation: true })` enables the layer only when it is
installed: `engine.device.validation` says whether it is on. It comes with
the SDK, found through `VK_LAYER_PATH`, which `setup-env.sh` sets.

### The native window stays black or does not open

- No display: the windows need X11 or Wayland (`DISPLAY` or
  `WAYLAND_DISPLAY`).
- On Dawn, frames are shown one or two frames late, by copy: a first frame
  takes a moment.
- `--validation` on the native demo prints the Vulkan messages at exit.
