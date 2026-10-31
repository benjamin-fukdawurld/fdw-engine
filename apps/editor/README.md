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
- **The page** is the shell of `@fdw/editor-ui` ([its README](../../packages/editor-ui/README.md)), given the host of Electron (`src/renderer/src/host.tsx`): the port to the engine, the viewport; the storage (`userData/storage/*.json`), the file dialogs and the popouts through the main process (`src/main/host.ts`); the sample plugin ([`@fdw/editor-plugin-sample`](../../packages/editor-plugin-sample/README.md)) and that of the tutorial of the documentation ([`@fdw/editor-plugin-isolate`](../../packages/editor-plugin-isolate/README.md)), their code in chunks loaded at their first activation event (`src/renderer/src/styles.css` gives Tailwind their classes). It reserves an area (`RemoteViewport`), reads it at each animation frame and sends its bounds in device pixels to the engine (an empty area when the panel is behind another tab), over a `MessagePort` given to both at each page load: the main process stays out of the frames. The swapchain follows the size of the area.
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

## The executable

```sh
npx nx run editor:package   # release/: a portable executable (Windows), an AppImage (Linux)
```

`scripts/package.mjs` gathers in `dist/` what the engine process reads beside the bundle: the addons, each with its DXC; the models of the forest (`tps`); the programs of the scenes, precompiled by `scripts/precompile.ts` with those addons (the key of a program has the version of DXC), which plays the scenes with the `EditorEngine` on an offscreen surface, on Vulkan and on Direct3D 12 under Windows. It needs a device (a GPU, lavapipe, WARP); `--no-precompile` ships none. electron-builder (`electron-builder.yml`) puts `dist/` in the resources of the executable; packaged, the main process gives their paths to the engine process. The engine reads the programs shipped before the cache of the user (`LayeredShaderCache`). No Dawn fallback in the executable: it needs a Node of its own.

## Tests

The editor end to end (`tests/editor.spec.ts`), Electron started by Playwright in an X server of its own (`xvfb-run`), on lavapipe: the drivers of a GPU do not present into the windows of Xvfb. The inputs are given by the X server (XTest), as a user would, through the child window: `tests/xprobe.c`, built at the first run, gives them and reads the pixels of the screen, where the child window is (a capture of the page does not have it). Each test has a user data of its own (`FDW_USER_DATA`), so the default layout.

- the level drawn on Vulkan in the area of the viewport, the swapchain of its size;
- a click of the X server on an object of the viewport selects it, the keys reach the shortcuts once the viewport is clicked;
- a right drag turns the camera, also past the edge of the viewport (the pointer captured);
- the viewport follows the window resized; no frames while the window is hidden, again once shown;
- the command palette over the viewport shows through a hole;
- a reload of the page connects it again to the engine; Dawn when asked for, copied into the window.

```sh
npx nx test editor   # installs, builds the addons and the bundle, then runs
```

Tagged `gpu`: they run in the native job of the CI. Not tested there: the pointer lock (it needs a gesture of the user), the minimization and the focus of the window (Xvfb has no window manager: the window is hidden and shown instead).

## Performance

`scripts/measure.mjs` measures the cost of the native viewport on the display and the GPU of the machine (step 5 of P18): a scene in a viewport of 1280 × 720, then the same scene in a window of `demo-native`. For each case, the frames per second, the CPU time of a frame (the status bar shows it: the CPU of the process on the desktop, where the swapchain waits for the display inside the frame) and its GPU time (the passes of the level, by timestamps), the CPU of each process (from `/proc`). The last results, on an RTX 2060 SUPER (X11, GNOME), are in `scripts/measure.json`, and commented in the documentation ([The native viewport](https://benjamin-fukdawurld.github.io/fdw-engine/editor/native-viewport/)): the engine costs in the editor what it costs alone, the interface 5 to 6 % of a core, the holes nothing measurable, the Dawn fallback 14 % of a core more.

```sh
npx nx run editor:build
node apps/editor/scripts/measure.mjs --out measures.json   # --seconds 10 --repeat 3
```
