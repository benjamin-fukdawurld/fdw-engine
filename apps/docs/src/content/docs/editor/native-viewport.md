---
title: The native viewport
description: 'How the desktop editor shows the engine in its window, on Vulkan and without copy, how the inputs reach it, and what it costs.'
sidebar:
  order: 4
---

The desktop editor is an Electron application, but its 3D view is not a
`<canvas>` of the page: the engine renders it natively, on Vulkan, into a
window of its own placed over the area of the viewport. This page tells
how, for those who work on the editor or write another host.

## The processes

```
page (React)  ── MessagePort ──►  engine process (utility process of Electron)
  RemoteViewport: the bounds,        EditorEngine, the scenes, the level
  the inputs, the holes              a Vulkan swapchain on the child window
        ▲                            fdw_editor.node: the child X11 window
        │ a port at each page load
main process: the XID of the window, the dialogs, the storage
```

- **The engine runs in a utility process** of Electron: it never blocks
  the interface, and the interface never waits for a frame. The main
  process starts it and gives it the identifier of the window (its XID);
  then, at each load of the page, a `MessagePort` to the page. The main
  process stays out of the frames.
- **The window of the viewport** is a child X11 window of the Electron
  window, made by the addon of the editor (`apps/editor/native`). The
  engine presents into it with its own swapchain (`@fdw/engine-vulkan`,
  FIFO): the pixels go from the GPU to the screen without passing by the
  CPU, nor by Chromium.
- **The page** reserves the area, measures it at each animation frame,
  and sends its bounds in device pixels to the engine, which places and
  sizes the window, and recreates the swapchain when the size changes. An
  area behind another tab is empty: no frames. Neither while the window is
  minimized or hidden.

## The inputs

The window of the viewport has an **empty input region** (the Shape
extension of X11): the mouse and the keyboard go through it to the element
of the page below. The page reads them there with a `WebInputSource`, as
it would on a canvas, and sends the calls to the engine, which replays them
(`RemoteInputSource`): the scenes read the same `Input` as in a browser.
The focus stays the page's, the pointer locks to its element, a drag is
captured by it, the gamepads are read by the page at each frame.

## The page over the viewport

Nothing of the page can be drawn above the window of the viewport. The
menus, the command palette, the floating groups of panels that cross it
are sent to the engine as **holes**, rectangles which the addon cuts out of
the window (its bounding region): the page shows through them. Chromium
recreates its own windows when the window is resized; the viewport watches
them, and stays above.

## The backend and its fallback

On Vulkan, the path is the one above, without copy. When Vulkan does not
start (`FDW_BACKEND=dawn`, no device, no addon), the engine runs on Dawn,
in a Node process of its own: Dawn does not present into a window there,
so each frame is read back, and copied into the window by the addon
(MIT-SHM). A fallback that works, not the normal path.

## What it costs

Measured on Linux (X11, GNOME), an RTX 2060 SUPER at 60 Hz, the viewport
at 1280 × 720, by `apps/editor/scripts/measure.mjs`: the CPU of each
process in percent of a core (median of three runs of 10 seconds), and the
same scene in a window of `demo-native`, without the editor around it.

| Case                               | Frames/s | CPU of the engine | CPU of the interface¹ | GPU of a frame² |
| ---------------------------------- | -------- | ----------------- | --------------------- | --------------- |
| Editor, the level, Vulkan          | 60       | 7.9 %             | 5.5 %                 | 0.20 ms         |
| Editor, the level, palette over it | 60       | 8.8 %             | 6.1 %                 | 0.17 ms         |
| Editor, the level, Dawn            | 61       | 21.7 %            | 5.5 %                 | 0.16 ms         |
| Editor, `shadows`, Vulkan          | 60       | 7.8 %             | 5.1 %                 |                 |
| `demo-native`, `shadows`, Vulkan   | 61       | 7.3 %             |                       |                 |
| Editor, `tps`, Vulkan              | 60       | 75 %              | 5.7 %                 |                 |
| `demo-native`, `tps`, Vulkan       | 60       | 85 %              |                       |                 |

¹ The main process, the page and the GPU process of Chromium. ² The passes
of the level, measured by GPU timestamps (the status bar shows them).

- **The engine costs in the editor what it costs alone**: the same scene
  takes the same CPU in the editor as in a window of its own.
- **The interface costs 5 to 6 % of a core**, with nothing moving: the
  page reads the bounds of the viewport and the holes at each animation
  frame.
- **The holes cost nothing measurable**: a palette over the viewport
  keeps 60 frames per second.
- **The Dawn fallback costs 14 % of a core more**, for the read back and
  the copy of each frame.

```sh
npx nx run editor:build
node apps/editor/scripts/measure.mjs --out measures.json
```

## The other systems

The same contract, a native surface placed in the area of the page and
transparent to the inputs, is planned on the other systems: a `WS_CHILD`
window under Windows, an `NSView` with a `CAMetalLayer` under macOS, a
sub-surface under Wayland (Electron runs on XWayland meanwhile). They come
with the distribution of the editor.
