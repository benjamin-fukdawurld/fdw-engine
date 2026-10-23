# @fdw/editor-ui

The interface of the editor, shared by its hosts: the Electron application (`apps/editor`) and, to come, the web one (P18 of [design/roadmap.md](../../design/roadmap.md), design in [design/editor-ui.md](../../design/editor-ui.md), in French).

```tsx
import { EditorShell, type EditorHost } from '@fdw/editor-ui';

const host: EditorHost = { engine, Viewport, about: 'Electron 45 · linux' };
createRoot(root).render(<EditorShell host={host} />);
```

- **The host** (`EditorHost`) gives the connection to the engine, the component of the viewport and what to show of itself in the status bar. The files, the persistence, the popouts and the plugins come with the steps that use them.
- **The protocol** (`@fdw/editor-ui/protocol`, without React): the messages between the page and the engine, the bounds of the viewport, the scene, the inputs. The shell never holds an object of the engine, only an `EngineConnection`: the engine may run in another process.
- **`RemoteViewport`**: the viewport of an engine out of the page, which renders natively over the area. It sends the bounds of the area in device pixels, and the inputs read on it by a `WebInputSource`.
- React is a peer dependency: the application gives its own (`resolve.dedupe` in Vite).
