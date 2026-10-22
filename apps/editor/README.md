# @fdw-engine/editor

The editor, an Electron and React application (P18 of [design/roadmap.md](../../design/roadmap.md), in French). Not part of the root npm workspaces: it has its own `node_modules`.

## The native viewport (prototype, Linux X11)

The 3D view is not a `<canvas>`: React reserves an area of the page (`Viewport.tsx`), measures it with a `ResizeObserver` and sends its bounds in device pixels to the main process; the addon of `native/` places a child X11 window of the Electron window over it, and draws into it with a Vulkan swapchain of its own, on a render thread. For now, a turning triangle.

- The child window has an empty input region (Shape extension): the mouse and keyboard reach the page.
- Chromium recreates its own child windows when the window is resized: the viewport watches them (`SubstructureNotifyMask`) and stays above.
- Electron runs on X11 (`--ozone-platform=x11`), XWayland under Wayland.

## Building and running

The addon needs the Vulkan SDK (`source <sdk>/setup-env.sh`), libX11 and libXext:

```sh
cd apps/editor
npm install
npm run build:native   # build/fdw_editor.node
npm run dev
```

From a terminal of VS Code, unset `ELECTRON_RUN_AS_NODE`, which makes Electron start as Node.
