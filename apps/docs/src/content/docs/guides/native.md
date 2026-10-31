---
title: Native
description: How the engine runs in Node, presents into native windows, and drives Vulkan.
sidebar:
  order: 7
---

Outside of the browser, the engine runs in **Node**, with native code in
**addons**. The TypeScript of the engine is unchanged: only the engine and
the surface are native.

## The layers

```
@fdw/engine-native (TS) ──► fdw_native.node (C, Node-API) ──► fdw_window (C++, C API) ──► SDL3
                                                           └─► fdw_audio (C, C API) ──► miniaudio
@fdw/engine-vulkan (TS) ──► fdw_vulkan.node (C, Node-API) ──► fdw_vulkan (C++20, C API) ──► Vulkan, DXC
```

- The **libraries** (`fdw_window`, `fdw_vulkan`) do the work, behind a C
  API (`native/include/fdw/*.h`). Another host — a native application, a
  FFI — can use them without Node.
- The **addons** are thin Node-API bindings, in C. Node-API has a stable
  ABI: an addon built once runs on every Node version.
- Everything is built by CMake, in C++20, for portability. Linux is
  supported today.

## Windows and the loop

`NativeWindow` is an SDL3 window. Its events are DOM events
(`NativeWindowEvent`): `close`, `resize`, `keydown`, `keyup`, `pointermove`,
`pointerdown`, `pointerup`, `wheel`, `blur` (the keyboard focus was lost),
and `gamepadconnected`, `gamepaddisconnected`, sent to every window. The
key events give `key` (the name of the key in the layout) and `code` (its
position, as the `code` of the DOM). `width` and `height` are in pixels;
`title` and `vsync` can change at any time.

The gamepads are read when needed: `NativeWindow.gamepads()` lists them,
`NativeWindow.readGamepad(id, buttons, axes)` reads one in the standard
layout of the Gamepad API. `NativeInputSource` of `@fdw/engine-input-native`
uses them: see [Input](/fdw-engine/guides/input/).

`runLoop(frame, { throttle })` replaces `requestAnimationFrame`: each turn
dispatches the events of the windows, calls `frame(now)`, waits for
`throttle()` if given, then yields to the Node event loop, so that promises,
timers and I/O run between frames. It returns `{ stop(), done }`.

## Dawn: presentation by copy

`createDawnEngine()` returns a `WebGpuEngine` on [Dawn](https://dawn.googlesource.com/dawn),
through the `webgpu` npm package. Dawn from npm cannot present into a
window, so `DawnWindowSurface`:

1. renders the frame into a texture;
2. copies it into a buffer, read back asynchronously;
3. gives the pixels to the window, which shows them.

A ring of readback buffers keeps the GPU busy; `throttle()` bounds the frames
in flight (2). The cost is a copy and a frame or two of latency: fine for
tools and development, not for a game. Building Dawn with its own
swapchain would remove it.

## Vulkan

`@fdw/engine-vulkan` implements the `RenderBackend` on Vulkan 1.3:

- **Shaders**: the programs are generated in HLSL (Shader Model 6, HLSL 2021) by `HlslCodegen`, then compiled to SPIR-V by DXC, loaded at run time.
- **Commands**: the encoders write the commands of a frame as 32-bit words;
  `submit` replays them into a command buffer in a single native call.
- **Synchronization**: as in WebGPU, the library tracks how each texture
  and buffer was last used, and inserts the barriers: before a render pass
  for its attachments and resources (its commands are read ahead), before
  each dispatch for its groups, before each copy. The barriers of a pass
  are placed together, in one call, and each waits only for the stages of
  the last use (a vertex buffer read waits for the copy that wrote it, not
  for every command), uploads and reads back included.
- **Writes**: `buffer.write` and texture uploads follow WebGPU's
  `queue.writeBuffer`: copied at once, applied in queue order before the
  next commands.
- **Submissions** are ordered by a timeline semaphore; destroyed resources
  are released once the GPU is done with them.
- **Memory** is allocated with VMA, the Vulkan functions loaded with volk.

`VulkanWindowSurface` presents through a **swapchain**: FIFO with `vsync`,
mailbox or immediate without; recreated when the window is resized; at
most two frames in flight. The window gives its native handles (X11,
Wayland, Win32, Cocoa) to the surface.

`new VulkanEngine({ validation: true })` enables the Khronos validation
layer when it is installed; `engine.device.takeMessages()` returns its
messages since the last call.

## The cache of the programs

On Vulkan and Direct3D 12, the programs are compiled from HLSL by DXC, about
a dozen milliseconds each. `FileShaderCache` keeps them between runs, a file
per program, under a key made of the HLSL, the arguments and the version of
DXC: the second start does not compile them again (half a second less for
`tps`). The editor and `demo-native` use it; another host gives it to its
engine:

```ts
const engine = new VulkanEngine({ shaderCache: new FileShaderCache() });
```

It lives in the cache directory of the user (`%LOCALAPPDATA%\fdw-engine\shaders`,
`~/.cache/fdw-engine/shaders`), or in `FDW_SHADER_CACHE`. Deleting it only
costs one slower start.

An application can also ship its programs, compiled ahead of time with the
DXC it ships: `FileShaderCache.fromEnvironment(directory)` reads them first,
then the cache of the user, where the programs not shipped (the materials of
a level) go (`LayeredShaderCache`). The first start then does not run DXC
either. The executable of the editor is built this way.

## Environment variables

| Variable               | Effect                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `VULKAN_SDK`           | Set by the SDK's `setup-env.sh`: needed to build the Vulkan addon |
| `FDW_DXC_LIBRARY`      | The DXC library to load (`libdxcompiler`)                         |
| `FDW_NATIVE_ADDON`     | Loads the window addon from another path                          |
| `FDW_VULKAN_ADDON`     | Loads the Vulkan addon from another path                          |
| `NODE_API_INCLUDE_DIR` | The Node-API headers used to build the addons                     |
| `FDW_SHADER_CACHE`     | The directory of the compiled programs; `off`: no cache           |
| `FDW_D3D12_ADAPTER`    | `warp`: Direct3D 12 on WARP, the software rasterizer of Windows   |
| `FDW_FROM_SOURCE`      | Builds the addons with CMake rather than fetching prebuilt ones   |

## Further

The design, its alternatives (Deno, Electron, a native host) and the
follow-ups — Windows and macOS, prebuilt addons, Direct3D 12 — are in
`design/native-backends.md` (in French).
