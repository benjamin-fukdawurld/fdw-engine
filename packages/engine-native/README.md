# @fdw/engine-native

The engine outside of the browser, in Node: native windows, a render loop, and surfaces presenting into them. Linux first; the native code is kept portable (CMake, C++20, SDL3, Node-API). See [design/native-backends.md](../../design/native-backends.md) (in French).

## Position in the stack

```
engine-core ──► engine-backend ◄── engine-webgpu ◄── engine-native ──► fdw_native.node (C, Node-API)
                                                                          └─► fdw_window (C++, C API) ──► SDL3
```

## Building the addon

```sh
npx nx run engine-native:build-native   # or: node packages/engine-native/scripts/build.mjs [--debug]
```

CMake fetches SDL3 (3.2.0) on the first build and links it statically into `build/fdw_native.node`. The Node-API headers come from a Node installation: Node-API has a stable ABI, so any one works. The script looks next to the running Node, then in the `PATH`; set `NODE_API_INCLUDE_DIR` to choose. `FDW_NATIVE_ADDON` loads an addon from another path.

The native library has a C API (`native/include/fdw/window.h`), and the addon is a thin binding to it. The same library can be used by another host (a FFI, a native application).

## Public API

| Export                                              | Kind     | Description                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NativeWindow`                                      | class    | A native window: `width` / `height` in pixels, `title`, `vsync`, `presentRgba()`, `destroy()`. Its events are DOM events (`NativeWindowEvent`): `close`, `resize`, `keydown` / `keyup` (`key`, `code`, `repeat`, modifiers), `pointermove` / `pointerdown` / `pointerup` / `wheel` (`x`, `y`, `button`, `dx`, `dy`), `blur`, `gamepadconnected` / `gamepaddisconnected` |
| `NativeWindow.gamepads`, `NativeWindow.readGamepad` | static   | The gamepads connected, and the state of one in the standard layout of the Gamepad API: what `@fdw/engine-input-native` reads                                                                                                                                                                                                                                           |
| `runLoop`                                           | function | The render loop in place of `requestAnimationFrame`: dispatches the window events, calls the frame, waits for its `throttle`, lets the Node event loop run. Returns `{ stop(), done }`                                                                                                                                                                                  |
| `DawnWindowSurface`                                 | class    | A `Surface` showing WebGPU (Dawn) frames in a `NativeWindow`, by copy: rendered into a texture, read back, shown by the window. `throttle()` bounds the frames in flight (2 by default). For development and tools: one copy and a frame or two of latency                                                                                                              |
| `VulkanWindowSurface`                               | class    | A `Surface` presenting Vulkan frames into a `NativeWindow` created with `vulkan: true`, without copy: a swapchain (`@fdw/engine-vulkan`) recreated when the window is resized; `vsync` option. Needs no throttle: the swapchain sets the pace                                                                                                                           |
| `createDawnEngine`                                  | function | A `WebGpuEngine` on Dawn (the `webgpu` package), whose WebGPU globals become globals                                                                                                                                                                                                                                                                                    |
| `loadAddon`, `setAddon`                             | function | The addon, and its replacement in tests                                                                                                                                                                                                                                                                                                                                 |

## Usage

```ts
import {
  createDawnEngine,
  DawnWindowSurface,
  NativeWindow,
  runLoop,
} from '@fdw/engine-native';

const engine = await createDawnEngine();
const window = new NativeWindow({ title: 'Demo', width: 1280, height: 720 });
const surface = new DawnWindowSurface(window);
await surface.init(engine);

const loop = runLoop(
  (time) => renderer.render({ items, camera, surface, time: time / 1000 }),
  {
    throttle: () => surface.throttle(),
  }
);
window.addEventListener('close', () => loop.stop());
await loop.done;
surface.destroy();
window.destroy();
```

On Vulkan, the window is created with `vulkan: true` and presented through `VulkanWindowSurface`: `window.nativeHandle` gives the window system and its handles to the swapchain.

`apps/demo-native` runs the scenes of the demo this way: `npx nx run demo-native:start -- shadows` (or `pbr`), on Dawn by default, on Vulkan with `--vulkan` (`--validation` for the validation layer, `--no-vsync` to measure).
