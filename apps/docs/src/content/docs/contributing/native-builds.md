---
title: Native builds
description: Build the native addons, set up the Vulkan SDK, and debug the native code.
sidebar:
  order: 5
---

Two packages have native code: `engine-native` (windows over SDL3, audio
over miniaudio) and
`engine-vulkan` (the Vulkan backend). Each has a `native/` directory built
by CMake into `build/`, by the shared script `tools/native/build-addon.mjs`.

## Requirements

- CMake 3.24 or later, and a C/C++20 compiler (GCC or Clang).
- On Linux, the development packages SDL3 needs for its video backends:
  X11 and/or Wayland, as for any SDL build.
- The **Node-API headers**, from any Node installation: the script looks
  next to the running Node, then in the `PATH`. Set `NODE_API_INCLUDE_DIR`
  if they are elsewhere.
- For Vulkan, the **Vulkan SDK**, 1.3 or later.

SDL3 and miniaudio are downloaded by CMake (`FetchContent`) on the first
build, and linked statically: the addon has no runtime dependency on them.
miniaudio loads the audio system of the machine when an engine is created
(PulseAudio or ALSA on Linux), and falls back to a null device without
one.

## The Vulkan SDK

Download the Linux tarball from [LunarG](https://vulkan.lunarg.com/sdk/home),
extract it, and source its environment in every shell that builds or tests:

```sh
tar xf vulkansdk-linux-x86_64-<version>.tar.xz -C ~/vulkan
source ~/vulkan/<version>/setup-env.sh   # VULKAN_SDK, PATH, LD_LIBRARY_PATH, VK_LAYER_PATH
```

Add the `source` line to `~/.profile` to make it permanent. The SDK gives
the headers, volk, VMA, DXC (`libdxcompiler`, loaded at run time),
`spirv-val`, `spirv-cross` and the validation layer.

## Building

```sh
npx nx run engine-native:build-native
npx nx run engine-vulkan:build-native
```

Or directly, with a debug build:

```sh
node packages/engine-native/scripts/build.mjs --debug
node packages/engine-vulkan/scripts/build.mjs --debug
```

Without `VULKAN_SDK`, the Vulkan build is skipped with a warning. The test
and start targets depend on `build-native`, so Nx builds the addons when
needed.

## Structure of a native package

```
native/
  CMakeLists.txt
  include/fdw/<name>.h    The C API of the library
  src/                    The library (C++20), and node_<name>.c, the Node-API binding
scripts/build.mjs         Calls tools/native/build-addon.mjs
src/addon.ts              Loads the addon, and types its functions
```

- The library does the work and knows nothing of Node; the binding converts
  arguments and errors.
- The TypeScript side loads the addon lazily (`loadAddon()`), and tests can
  replace it (`setAddon()`) with a mock.
- The Vulkan objects are identified by integer ids on the TypeScript side;
  the frames are passed as arrays of 32-bit command words.

## Portability

The native code is portable by construction: CMake, C++20 without system
APIs, SDL3 for windows and native handles, dependencies fetched rather than
taken from the system. What depends on the platform — window handles,
library paths — stays in a few isolated places. Windows and macOS (through
MoltenVK) are planned; see `design/backlog.md`.

## Debugging

- `--validation` on the native demo, or
  `new VulkanEngine({ validation: true })`: the Khronos layer checks every
  Vulkan call; `device.takeMessages()` returns its messages.
- A `--debug` build keeps the symbols: run Node under `gdb --args node …`
  to debug the addon.
- `FDW_NATIVE_ADDON` and `FDW_VULKAN_ADDON` load an addon built elsewhere.
