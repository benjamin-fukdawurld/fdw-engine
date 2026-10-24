# @fdw-engine/editor

The editor, an Electron and React application (P18 of [design/roadmap.md](../../design/roadmap.md), in French). Not part of the root npm workspaces: it has its own `node_modules`, and bundles the sources of the `@fdw/*` packages.

The interface, and the protocol between the page and the engine, are in `@fdw/editor-ui`, shared with the web editor ([apps/editor-web](../editor-web/README.md)); this application is its Electron host.

## The native viewport (Linux X11)

The 3D view is not a `<canvas>`: the engine renders it natively, on Vulkan (or Dawn, below), into a window placed over the page.

```
renderer (React)  ── MessagePort ──►  engine process (utility process)
  RemoteViewport: bounds, inputs        VulkanEngine (@fdw/engine-vulkan), the demo scenes
        ▲                                ViewportSurface: a swapchain on the child window
        │ port at each page load         fdw_editor.node: the child X11 window
main process: EngineProcess (src/main/engine.ts), the XID of the window
```

- **The engine process** (`src/engine`) is a utility process of Electron: the engine never blocks the interface. The main process gives it the XID of the Electron window; the addon of `native/` creates a child window in it, and `@fdw/engine-vulkan` presents into that window with its own swapchain (FIFO), without copy. The process is the platform of the `EditorEngine` of `@fdw/editor-ui`, which handles the messages of the page and the scenes.
- **The page** is the shell of `@fdw/editor-ui` ([its README](../../packages/editor-ui/README.md)), given the host of Electron (`src/renderer/src/host.tsx`): the port to the engine, the viewport; the storage (`userData/storage/*.json`), the file dialogs and the popouts through the main process (`src/main/host.ts`); the sample plugin ([`@fdw/editor-plugin-sample`](../../packages/editor-plugin-sample/README.md)), its code in a chunk loaded at its first activation event (`src/renderer/src/styles.css` gives Tailwind its classes). It reserves an area (`RemoteViewport`), reads it at each animation frame and sends its bounds in device pixels to the engine (an empty area when the panel is behind another tab), over a `MessagePort` given to both at each page load: the main process stays out of the frames. The swapchain follows the size of the area.
- **The inputs**: the child window has an empty input region (Shape extension), so the mouse and keyboard reach the element of the page. A `WebInputSource` reads them there, as on a canvas, and its calls are replayed by the engine (`RemoteInputSource`); the pointer locks to the element, the gamepads of the page are sent at each animation frame and rumble there.
- **The scenes**: the level being edited (`level`, the first one; [the level](../../packages/editor-ui/README.md#the-level)), then those of `apps/demo-native`, chosen in the Scene menu (`FDW_SCENE` sets the first one): physics on Rapier, the ocean, the third-person game with its models, the sounds on miniaudio. The images of the levels opened are decoded by stb (`pixelCodec`).
- **The page over the viewport**: nothing of the page can be drawn above the child window. The menus, the floating groups and the drop targets of dockview that cross it are sent as holes (`viewportHoles` of `@fdw/editor-ui`, at each animation frame), which the addon cuts out of the window by its bounding region (`setViewportShape`, Shape extension): the page shows through them.
- Chromium recreates its own child windows when the window is resized: the viewport watches them (`SubstructureNotifyMask`) and stays above. No frames while the window is minimized; on closing, the engine stops before the window goes.
- Electron runs on X11 (`--ozone-platform=x11`), XWayland under Wayland.

## The backend

`FDW_BACKEND` chooses it (design in [design/editor-ui.md §4](../../design/editor-ui.md#4-le-choix-du-backend), in French): `vulkan` by default, `dawn`. The main process reads it and gives it to the engine process, which falls back to Dawn when Vulkan does not start (no addon, no device, a swapchain the window refuses) or when the value is unknown. The status bar shows the backend running, and the reason of a fallback.

```sh
FDW_BACKEND=dawn npx nx run editor:dev
```

- **Vulkan** presents into the child window with its swapchain, without copy (`src/engine/backends.ts`).
- **Dawn** runs in a Node process of its own (`src/engine/dawn.ts`), started by the engine process, which relays the messages of the page to it over the IPC of Node (as JSON: the V8 serializers of Electron and Node differ; the bytes of the levels in base64, `src/engine/wire.ts`). Not in the engine process: the V8 of Electron refuses the external `ArrayBuffer`s that `dawn.node` makes at each `getMappedRange`. Its node is `FDW_NODE`, else the one of the `PATH`; it must be Node 24. `dawn.node` does not present into a window: each frame is read back (`DawnWindowSurface` of `@fdw/engine-native`) and copied into the child window by the addon (`presentViewport`: MIT-SHM, `XPutImage` without it), at 60 frames per second at most. A fallback that works, not the normal path.

Both run the same `EngineSession` (`src/engine/session.ts`): the `EditorEngine` of `@fdw/editor-ui`, the page it talks to, the visibility of the window, the stop.

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
