# @fdw/editor-ui

The interface of the editor, shared by its hosts: the Electron application (`apps/editor`) and the web one (`apps/editor-web`) (P18 of [design/roadmap.md](../../design/roadmap.md), design in [design/editor-ui.md](../../design/editor-ui.md), in French).

```tsx
import { EditorShell, type EditorHost } from '@fdw/editor-ui';
import '@fdw/editor-ui/styles.css';

createRoot(root).render(<EditorShell host={host} />);
```

## The host

An application gives the shell an `EditorHost`:

| Service     | What                                                      | Electron (`apps/editor`)                           | Web (`apps/editor-web`)                                   |
| ----------- | --------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `engine`    | The connection to the engine (`EngineConnection`)         | A `MessagePort` to the utility process             | A `MessageChannel` to the engine in the page              |
| `Viewport`  | The component of the area where the engine shows its view | `RemoteViewport`, a child X11 window over the area | `CanvasViewport`, the canvas of the engine in the area    |
| `files`     | Opening and saving the files of the user                  | The dialogs of Electron, read by the main process  | The File System Access API, else an import and a download |
| `storage`   | JSON documents kept between sessions (the layout), by key | Files in `userData/storage`                        | IndexedDB                                                 |
| `popoutUrl` | The empty page the popouts of the panels open             | `popout.html`, the only window the page may open   | `popout.html`, subject to the popup blocker               |
| `about`     | Shown at the right of the status bar                      | The versions of Electron, Chrome and Node          | The browser and the platform                              |

The plugins come with their manifest (step 12). The shell is tested with a fake host (`EditorShell.spec.tsx`).

## The engine side

- **The protocol** (`@fdw/editor-ui/protocol`): the messages between the page and the engine, the bounds of the viewport, the scene, the inputs. The shell never holds an object of the engine: the engine may run in another process.
- **`EditorEngine`** (`@fdw/editor-ui/engine`, without React): the engine side of the protocol, independent of where it runs. It receives the messages of the page, shows the scenes in the viewport and sends back what it does. Its platform (`EditorEnginePlatform`) gives it the backend, the viewport, the surface, the scenes and the pace of the frames: the utility process of Electron (`apps/editor/src/engine`) on Vulkan, the page of the web editor (`apps/editor-web`) on WebGPU. Where the engine runs in the page, the platform also gives the inputs (a `WebInputSource` on the viewport), and the scenes read them without a relay.
- **`startBackend`** (`@fdw/editor-ui/engine`): the choice of the backend by `FDW_BACKEND`, the same in every host: the preferred one without the variable (Vulkan, WebGPU), the fallback when the one asked for does not start or is unknown (Dawn, WebGL2), with the reason. The `ready` message gives the backend running and the reason of a fallback, shown in the status bar.
- **`useViewportBounds`**: the bounds of the area of the viewport in device pixels, sent to the engine whenever they change: it places its window over the area (Electron), or sizes its canvas to it (web).
- **`RemoteViewport`** and **`RemoteInputSource`**: the two ends of the inputs when the engine is out of the page. The viewport sends the bounds of its area in device pixels and the inputs read on it by a `WebInputSource`; the input source replays them in the engine.

## The components

[shadcn/ui](https://ui.shadcn.com/) on Tailwind 4, in `src/components/ui` (an `xs` size added for the bars of the editor), with the theme in `src/styles.css`: the application's Vite runs Tailwind (`@tailwindcss/vite`), the `dark` class on `<html>` sets the dark theme. The components are copied from shadcn with relative imports. The selects are native: their lists open above the native viewport, those of Radix would be hidden by it.

React is a peer dependency: the application gives its own (`resolve.dedupe` in Vite).
