# @fdw/editor-ui

The interface of the editor, shared by its hosts: the Electron application (`apps/editor`) and the web one (`apps/editor-web`) (P18 of [design/roadmap.md](../../design/roadmap.md), design in [design/editor-ui.md](../../design/editor-ui.md), in French).

```tsx
import { EditorShell, type EditorHost } from '@fdw/editor-ui';
import '@fdw/editor-ui/styles.css';

createRoot(root).render(<EditorShell host={host} />);
```

## The host

An application gives the shell an `EditorHost`:

| Service     | What                                                      | Electron (`apps/editor`)                             | Web (`apps/editor-web`)                                   |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `engine`    | The connection to the engine (`EngineConnection`)         | A `MessagePort` to the utility process               | A `MessageChannel` to the engine in the page              |
| `Viewport`  | The component of the area where the engine shows its view | `RemoteViewport`, a child X11 window over the area   | `CanvasViewport`, the canvas of the engine in the area    |
| `files`     | Opening and saving the files of the user                  | The dialogs of Electron, read by the main process    | The File System Access API, else an import and a download |
| `storage`   | JSON documents kept between sessions (the layout), by key | Files in `userData/storage`                          | IndexedDB                                                 |
| `popoutUrl` | The empty page the popouts of the panels open             | `popout.html`, the only window the page may open     | `popout.html`, subject to the popup blocker               |
| `about`     | Shown at the right of the status bar                      | The versions of Electron, Chrome and Node            | The browser and the platform                              |
| `plugins`   | The plugins of the application, after those of the editor | The sample and isolate plugins, chunks of the bundle | The sample and isolate plugins, chunks of the bundle      |

The shell is tested with a fake host (`fakeHost` of `@fdw/editor-ui/testing`, in jsdom: `EditorShell.spec.tsx`, and the tests of the plugins), its layout in Chromium with the web host (`apps/editor-web`).

## The layout

Laid out like a QMainWindow ([design/editor-ui.md §3](../../design/editor-ui.md#3-le-layout-façon-qmainwindow), in French):

```
┌─────────────────────────── menu bar ───────────────────────────┐
├────────────────────────── toolbars, top ───────────────────────┤
│ toolbars │ left dock │   central area   │ right dock │ toolbars │
│          │           ├──────────────────┤            │          │
│          │           │   bottom dock    │            │          │
├───────────────────────── toolbars, bottom ─────────────────────┤
└────────────────────────── status bar ──────────────────────────┘
```

- **The workbench** (`Workbench.tsx`) is a `GridviewReact` of [dockview](https://dockview.dev/) with four areas, the central one and the docks, each a `DockviewReact`: tabs, groups split by dragging, floating groups in the central area. A tab moves within its area, not to another one.
- **The panels** are the views of the plugins (below), each a panel of the component `view` (`ViewHost`, `views.tsx`) with the id of its view; in a new layout, those `open` in their area, the first one registered active (the editor's before the host's): the viewport and a welcome page in the central area, the outliner and the inspector of the level (below), the console (the messages of the engine) and the list of the plugins in the docks. They stay mounted behind another tab and when moved (the `always` renderer): the viewport keeps its canvas or its window, hidden while its tab is.
- **The menu bar, the toolbars and the status bar** (`chrome.tsx`) are out of dockview, filled by the registries of the plugins. The View menu (the workbench plugin) shows and hides the docks, the panels, the toolbars (on one of the four sides) and the status bar, opens the command palette, and resets the layout; the Scene menu (the viewport plugin) chooses the scene: the level, or a demo scene; the File and Edit menus are the level's.
- **The layout document** (`layout.ts`, version 2), written by the host under the key `layout` once the changes settle: the docks shown, the toolbars and their side, the status bar (the editor store), the sizes of the docks (`toJSON` of the grid) and the panels of each area (`toJSON` of each area), the state of the machine and of the plugins (below). A document of another version, or one dockview does not restore, gives the default layout. A panel whose plugin is gone stays, and tells so.
- **The theme of dockview** (`.dockview-theme-fdw` in `src/styles.css`): the sizes of its dark theme, the colors of shadcn.

## The state and the services

Following [design/editor-state.md](../../design/editor-state.md) (in French), in `src/state`. The shell makes the runtime of the editor (`EditorRuntime`) once the layout is read, and disposes it when it goes; the state of the engine is followed from the start, not to miss its first messages. `onRuntime` gives it to the host (and to the tests).

- **The services** (`ServiceRegistry`): typed ids (`serviceId<T>('name')`, `get` returns a `T`), made at their first use (`lazy: false` at once), each with the services of its own scope. A scope (`createScope(name, visible?)`), for a plugin, sees its services and those of its parent, all or those listed; disposed, it disposes what it registered, the last first (the `dispose` option, else the `dispose()` of the service). The runtime registers the host, the connection and the state of the engine, the stores, the machine, the context keys and the registries of the tools and the modes (`IEditorHost`, `IEditorMachine`, `IContextKeys`…). Nothing of it is kept.
- **The stores** ([`@xstate/store`](https://stately.ai/docs/xstate-store)): the editor store (`createEditorStore`), serializable, with the chrome (the docks, the toolbars and their side, the status bar), the selection (ids, those of the level) and the state of each plugin; the engine store (`createEngineStore`), what the engine tells of itself (the backend, the scenes, the stats, the console), from its messages, never kept; the level store (`createLevelStore`), the projection of the level (below), never kept either.
- **The machine of the editor** (`editorMachine`, XState 5): fixed, in parallel, the focus of the window, the mode and two slots of tools, `primary` then `secondary` by priority. A tool (`ToolSpec`) or a mode (`ModeSpec`) of a plugin is a child actor, made from its registry (`runtime.tools`, `runtime.modes`) when activated: one tool at a time in a slot, the slots independent. Its logic is given a `ToolContext`, never the machine: the context keys, `done()` and `cancel()`. The core names its guards and actions (`toolAllowed`, `startTool`…) and `startEditor` implements them on the registries, with the `when` clause of the tool or the mode. Escape (`EDITOR.CANCEL`) ends every tool; the focus of a view (`FOCUS.VIEW`, from the area clicked or focused) and the loss of the window (`FOCUS.WINDOW`) are handled by the core, then forwarded to the tools (`EDITOR.VIEW`, `EDITOR.BLUR`). A tool or a mode unregistered ends.
- **The context keys** (`createContextKeys`): derived from the machine and the stores, `editor.focusedArea`, `editor.focusedView`, `editor.windowFocused`, `editor.mode`, `tool.primary`, `tool.secondary`, `scene.hasSelection`, `engine.ready`, `engine.backend`, `engine.fallback`, `engine.scene`, `level.open`, `level.dirty`, `level.canUndo`, `level.canRedo`; a plugin may set its own (`keys.set`). The same object until a key changes.
- **The `when` clauses** (`compileWhen`, `matchesWhen`): as in VS Code, a key alone (truthy), `key == value` and `key != value` (a bare value, a number, `true`, or quoted), `!`, `&&` before `||`, parentheses. A clause that is not valid is false, with a warning.
- **The state kept**: the layout document holds, with the chrome and dockview, the snapshot of the machine (`persistEditor`) and the state of the plugins. XState does not persist an inline child: each tool is persisted on its own, with its id as its source, and restored with the logic of its registry; a tool or a mode no more registered restores as idle, a snapshot that does not restore gives the default state. The selection is not kept: its ids are those of a session of the engine (the project of P20 will keep it).
- **In React** (`editorContext.tsx`): `useEditor()` gives the runtime, `useSelector(store or actor, select)` a part of its snapshot, `useEngine()`, `useEditorStore()`, `useEditorMachine(select)`, `useWhen(clause)`. The status bar shows the mode and the tools active.

Tested without React (the services, the registries, the clauses, the keys, the machine and its persistence) and in the shell (the focus, the keys, the state kept). The routing of the inputs by the slots: the main button of the viewport goes to the tool of the primary slot (the level, below).

## The plugins

Following [design/editor-ui.md §6](../../design/editor-ui.md#6-les-plugins) (in French), in `src/plugins`: the model of VS Code, a manifest and code loaded on demand. The editor has no interface of its own: its panels, its menus, its toolbars and its status bar come from plugins, built in (`src/builtins`) or given by the host (`EditorHost.plugins`).

```ts
import type { EditorPlugin, PluginManifest } from '@fdw/editor-ui';

const manifest = {
  id: 'acme.notes',
  version: '1.0.0',
  engine: '^1.0.0', // a range of editorApiVersion
  contributes: {
    views: [{ id: 'acme.notes', title: 'Notes', location: 'right' }],
    commands: [
      { id: 'acme.clear', title: 'Clear', category: 'Notes', icon: 'trash' },
    ],
    menus: {
      menubar: [{ submenu: 'acme.menu', title: 'Notes' }],
      'acme.menu': [{ command: 'acme.clear' }],
    },
    toolbars: [
      { id: 'acme.bar', title: 'Notes', side: 'left', items: ['acme.clear'] },
    ],
    keybindings: [{ command: 'acme.clear', key: 'ctrl+alt+n' }],
    tools: [{ id: 'acme.pen', title: 'Pen', slot: 'primary', icon: 'pencil' }],
  },
} as const satisfies PluginManifest;

export const notesPlugin: EditorPlugin = {
  manifest,
  load: () => import('./main'),
};

// main.tsx
export function activate(context: PluginContext) {
  context.views.registerComponent('acme.notes', NotesPanel);
  context.commands.register('acme.clear', () =>
    context.state.set({ notes: '' }),
  );
  context.tools.register('acme.pen', () => penMachine);
}
```

- **The manifest** (`manifest.ts`), checked when the plugin is registered (`readManifest`): its id, its version, the range of the API it is written for (`engine`, against `editorApiVersion`), its contributions. An invalid manifest, or a contribution whose id is taken, makes the plugin `invalid`, without contributions.
- **The contributions**, declared at once, before the code is loaded: the commands (a title, a category, an icon, an `enablement` and a `toggled` clause; `palette: false` for one that needs arguments); the views (their area, `open` in a new layout, a `when` for the View menu); the menus by id (`menubar`, whose items are submenus; the items sorted by group, then by order, separated by group, each with a `when`); the toolbars (their side and visibility by default, their items, commands); the items of the status bar (a side, a priority; a component of the plugin, or a text that may run a command); the keybindings (`ctrl+shift+p`, `escape`, `f1`; the letters by their place on the keyboard; in a text field only those with ctrl, alt or meta, or escape; the last one registered whose clause holds wins); the tools and the modes, which are commands too (`Tool: Pen`, run again to end it). The icons are names of `editorIcons` (lucide), known without the code of the plugin.
- **The registries** of the runtime (`runtime.commands`, `views`, `menus`, `toolbars`, `statusBar`, `keybindings`, `tools`, `modes`): the shell only reads them.
- **The activation** (`PluginHost`, `runtime.plugins`): the code is loaded and `activate(context)` called at the first event that names the plugin: `onView:id` (its panel shown), `onCommand:id` (a command run from a menu, a toolbar, a key or the palette), `onTool:id`, `onMode:id`, implied by its contributions, and `onStartup` in its manifest. The plugins of `onStartup`, and those of the tools and the mode kept in the layout, are loaded before the runtime is made (`preparePlugins`): their `activate` registers their tools before the machine restores. So a plugin reads the machine and the context keys at the call (in a command, a component), not in `activate`: a warning tells it.
- **The context of a plugin** (`PluginContext`): its manifest; its scope of services (`context.services`, those of the editor and its own); `commands.register` and `execute`, `views.registerComponent`, `statusBar.registerComponent`, `menus.append` (items made by code: one per panel, per scene), `tools.register`, `modes.register`, `keys.set`; `state`, its JSON kept with the layout, and kept when the plugin is gone (`usePluginState` in React). A registration names a contribution of its manifest, else it throws; each one is in `context.subscriptions`.
- **The deactivation**: `deactivate()` of the plugin, then what it registered, the last first, and its scope; its tool ends. The Plugins panel lists the plugins and their state; one not built in is disabled there (its panel tells so), and enabled again. Not kept yet.
- **A missing plugin**: a panel of the layout whose view no plugin gives stays, and tells its plugin is missing; its tool or its mode restores as idle; its state is kept.
- **The command palette** (`CommandPalette.tsx`, cmdk in a dialog of Radix, a hole over the native viewport): Ctrl+Shift+P or F1, the commands enabled, by their category and title, with their key.
- **In React**: `useItems(registry)`, `useMenu(id)`, `usePluginState(id)`, `useToolSnapshot(slot)` (the state of the tool active in a slot), `CommandButton`.

**The part of a plugin in the engine** (P19): an `EngineExtension`, given to the engine by the host (`EditorEnginePlatform.extensions`, an `EngineExtensionFactory` by id), which receives the messages the plugin sends under its id (`extension` messages, JSON and bytes in `data`; `extensionChannel(connection, id)` in the page), sees the scene shown (`scene`, its `graphs`), works before each frame (`frame`) and may hold the scene (`holdsScene`: a debugger stopped, its frames not drawn). The editors of graphs are made so ([`@fdw/graph-editor`](../graph-editor/README.md)). A view may open beside the panels of its area (`split: 'right'` or `'below'`): the editors of graphs beside the viewport.

The plugins are trusted: they run in the page, with what it can do (sandboxed third-party plugins come later, with the import map that gives them React and this package). The sample plugin, a tool and a panel, is [`@fdw/editor-plugin-sample`](../editor-plugin-sample/README.md).

Tested without React (the manifests, the versions, the keys, the menus, the commands, the activation and the deactivation, the restore of a tool) and in the shell (a panel loaded when shown, a command from its menu and its key, a tool from a toolbar and Escape, the palette, a missing plugin, the Plugins panel).

## The level

The document the editor edits (P16), with the tools of P15 ([design/editor-state.md §2](../../design/editor-state.md#2-les-trois-niveaux), in French): it lives in the engine, which may run in another process; the page holds its projection, by ids, and changes it by commands only.

```
page                                       engine (@fdw/editor-ui/engine)
  level store: tree, selection, ◄─ level.* ─  LevelDocument: the Scene, its History,
  properties, history, rectangle              its Selection, SceneEvents → projection
  fdw.level, outliner, inspector ─ level.command ►  commands of P15 (undoable)
  tool of the primary slot ─ level.tool ►     LevelView (the scene `level`): picker,
                                              gizmo, outline, orbit camera
```

- **The document** (`LevelDocument`): a new one is the sample level (a ground, cubes, spheres, a table of five nodes, the sun), made only of meshes and materials made in code; another is a file of the user, opened by the host (`level.open`): a scene of the engine (`.scene.json`, its buffers in it) or glTF (`.glb`, `.gltf` with its buffers in it), read by the store of the levels (`installSceneIo`, `installGltfScenes`; the image codecs of the platform, `EditorEnginePlatform.imageCodecs`). Its references to other files are not found (a level of the user has no folder yet). Saved in one file, written by the engine (`level.file`) and saved by the host (`files.save`): the scene of the engine (`writeFdwScene`, its buffers embedded), or exported as a `.glb` (`writeGltf`, the instances expanded). Its components without a codec are kept, and saved again.
- **The projection** (`level.*` messages, `createLevelStore`): the tree whole when the level is opened (`level` then `level.nodes` with `reset`), then the changes grouped by batch of `SceneEvents` (one command, one step of a drag): the nodes changed (and the parents whose children changed), the ids removed. A node is `entity:generation`: never the id of another one. The selection (the active node last), the properties of the active node (name, visibility, transform with the rotation in degrees, components and the numbers of those saved field by field), the labels of the next undo and redo, the rectangle of a selection being dragged.
- **The commands** (`level.command`): undo, redo, delete, add (an empty node, a cube, a sphere, a point light), edit a property (consecutive edits of a field make one entry), move under another node, select (not in the history), frame. Each one is a command of P15 in the history of the level; a drag of the viewport is cancelled first.
- **The viewport** (`LevelView`, the scene `level` of the Scene menu, the first one by default): the secondary button turns the camera, the middle one pans, the wheel zooms; the main button is the tools' (`EditingTools`: click and rectangle select the node under the root, the handles of the gizmo drag), as the page routes it: the tool of the primary slot (`level.tool`): none, select; Move, Rotate, Scale, the gizmo; another one (a tool of a plugin), nothing. The keys are the page's (the keybindings below), never read by the engine. The rectangle is drawn by the page, four lines that are holes of the native viewport.
- **The plugin `fdw.level`** (built in): the File menu (new, open, save with Ctrl+S, export as glTF), the Edit menu (undo and redo with Ctrl+Z and Ctrl+Y, delete, Add, frame with F, the tools Q, W, E, R, the axes of the gizmo X, its pivot C, snapping), its toolbar, the name of the level in the status bar (`•` when changed). The settings of the gizmo are the state of the plugin, kept with the layout, and context keys (`level.gizmo.local`, `level.gizmo.origins`, `level.gizmo.snapping`).
- **The outliner** (`fdw.outliner`): the tree, the parents of the selection opened; a click selects (Shift adds, Ctrl toggles), a double click frames, the eye shows and hides, a node dragged onto another goes under it. **The inspector** (`fdw.inspector`): the properties of the active node, each field validated by Enter or by leaving it.

Tested without React (`LevelDocument`: the projection, the commands undone and redone, the components, saved and opened again in both formats; `EditorEngine`: its messages), in the shell (the tree, the inspector, opening and saving through the host, the routing by the tool of the primary slot, the rectangle) and in Chromium (a rectangle in the viewport picks, the tree selects, Delete and Ctrl+Z).

## The engine side

- **The protocol** (`@fdw/editor-ui/protocol`): the messages between the page and the engine, the bounds of the viewport, the scene, the inputs. The shell never holds an object of the engine: the engine may run in another process.
- **`EditorEngine`** (`@fdw/editor-ui/engine`, without React): the engine side of the protocol, independent of where it runs. Its statistics, once a second (`stats`): the frames per second, the mean CPU time of a frame (the CPU of the process where the platform gives `cpuTime`: a swapchain waits for the display inside the frame), the GPU time of the passes of the level (timestamps, where the backend has them), shown in the status bar. It receives the messages of the page, shows the scenes in the viewport and sends back what it does; it holds the level (above). Its platform (`EditorEnginePlatform`) gives it the backend, the viewport, the surface, the scenes and the pace of the frames: the utility process of Electron (`apps/editor/src/engine`) on Vulkan, the page of the web editor (`apps/editor-web`) on WebGPU. Where the engine runs in the page, the platform also gives the inputs (a `WebInputSource` on the viewport), and the scenes read them without a relay.
- **`startBackend`** (`@fdw/editor-ui/engine`): the choice of the backend by `FDW_BACKEND`, the same in every host: the preferred one without the variable (Vulkan, WebGPU), the fallback when the one asked for does not start or is unknown (Dawn, WebGL2), with the reason. The `ready` message gives the backend running and the reason of a fallback, shown in the status bar.
- **`useViewportBounds`**: the bounds of the area of the viewport in device pixels, read at each animation frame and sent to the engine when they change, empty while the area is hidden (behind another tab): it places its window over the area (Electron), or sizes its canvas to it (web).
- **`RemoteViewport`** and **`RemoteInputSource`**: the two ends of the inputs when the engine is out of the page. The viewport sends the bounds of its area in device pixels, the holes of the page over it, and the inputs read on it by a `WebInputSource`; the input source replays them in the engine.

## The components

[shadcn/ui](https://ui.shadcn.com/) on Tailwind 4, in `src/components/ui` (an `xs` size added for the bars of the editor), with the theme in `src/styles.css`: the application's Vite runs Tailwind (`@tailwindcss/vite`), the `dark` class on `<html>` sets the dark theme. The components are copied from shadcn with relative imports. The menu bar is the `Menubar` of shadcn (Radix). Nothing of the page is drawn above the native viewport of Electron: the popups of Radix, the floating groups and the drop targets of dockview, and the elements marked `data-over-viewport`, are holes in its window (`viewportHoles`, sent by `RemoteViewport`). The native selects open above it anyway.

React is a peer dependency: the application gives its own (`resolve.dedupe` in Vite).
