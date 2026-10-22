# @fdw-engine/editor

The editor, an Electron and React application (P18 of [design/roadmap.md](../../design/roadmap.md), in French). Not part of the root npm workspaces: it has its own `node_modules`, and bundles the sources of the `@fdw/*` packages.

## The native viewport (Linux X11)

The 3D view is not a `<canvas>`: the engine renders it natively, on Vulkan, into a window placed over the page.

```
renderer (React)  ── MessagePort ──►  engine process (utility process)
  Viewport.tsx: bounds, inputs          VulkanEngine (@fdw/engine-vulkan), the demo scenes
        ▲                                ViewportSurface: a swapchain on the child window
        │ port at each page load         fdw_editor.node: the child X11 window
main process: EngineProcess (src/main/engine.ts), the XID of the window
```

- **The engine process** (`src/engine`) is a utility process of Electron: the engine never blocks the interface. The main process gives it the XID of the Electron window; the addon of `native/` creates a child window in it, and `@fdw/engine-vulkan` presents into that window with its own swapchain (FIFO), without copy.
- **The page** reserves an area (`Viewport.tsx`), measures it with a `ResizeObserver` and sends its bounds in device pixels to the engine, over a `MessagePort` given to both at each page load: the main process stays out of the frames. The swapchain follows the size of the area.
- **The inputs**: the child window has an empty input region (Shape extension), so the mouse and keyboard reach the element of the page. A `WebInputSource` reads them there, as on a canvas, and its calls are replayed by the engine (`RemoteInputSource`); the pointer locks to the element, the gamepads of the page are sent at each animation frame and rumble there.
- **The scenes**: those of `apps/demo-native`, chosen in the header (`FDW_SCENE` sets the first one): physics on Rapier, the ocean, the third-person game with its models, the sounds on miniaudio.
- Chromium recreates its own child windows when the window is resized: the viewport watches them (`SubstructureNotifyMask`) and stays above. No frames while the window is minimized; on closing, the engine stops before the window goes.
- Electron runs on X11 (`--ozone-platform=x11`), XWayland under Wayland.

## Building and running

The addons need the Vulkan SDK (`source <sdk>/setup-env.sh`), libX11 and libXext:

```sh
npx nx run editor:dev   # builds the addons (editor, engine-native, engine-vulkan), then runs
```

Or by hand:

```sh
node packages/engine-native/scripts/build.mjs
node packages/engine-vulkan/scripts/build.mjs
cd apps/editor
npm install
npm run build:native   # build/fdw_editor.node
npm run dev
```

`FDW_VALIDATION=1` enables the Vulkan validation layer; its messages are printed when the engine stops. From a terminal of VS Code, unset `ELECTRON_RUN_AS_NODE`, which makes Electron start as Node.
