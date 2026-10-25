# @fdw-engine/editor-web

The web editor, a Vite and React application (P18 of [design/roadmap.md](../../design/roadmap.md), in French): the interface of `@fdw/editor-ui` ([its README](../../packages/editor-ui/README.md)), the same as the desktop editor ([apps/editor](../editor/README.md)), with the engine in the page.

```
page (React)                         the engine, in the page (src/engine.ts)
  EditorShell ── MessageChannel ──►  EditorEngine (@fdw/editor-ui/engine), the scenes
  CanvasViewport: the bounds          WebGPU or WebGL2, drawing into its canvas
        ▲                                   │
        └──── the element of the engine ◄──┘  its canvas, its inputs (WebInputSource)
```

- **The engine** (`src/engine.ts`) is the `EditorEngine` of `@fdw/editor-ui` behind a `MessageChannel`: the same protocol as the engine process of Electron, so that the shell never holds it. It will go into a worker (`OffscreenCanvas`) once the audio is solved there: `AudioContext` does not exist in a worker.
- **The viewport** (`src/CanvasViewport.tsx`) places the element of the engine in its area, and sends the bounds of the area in device pixels: they size the canvas. The element, with its canvas and its context, outlives the component: a remount does not lose them. Behind another tab, the area is empty: no frames are drawn.
- **The inputs**: the scenes read a `WebInputSource` on the element of the engine, without a relay; the pointer locks to it, a click gives it the keys. The audio starts at the first gesture on the page.
- **The host** (`src/host.tsx`): the documents of the editor (the layout) in IndexedDB, the files of the user through the File System Access API (Chromium), else an import and a download; the plugins of the application, the sample one ([`@fdw/editor-plugin-sample`](../../packages/editor-plugin-sample/README.md)) and that of the tutorial of the documentation ([`@fdw/editor-plugin-isolate`](../../packages/editor-plugin-isolate/README.md)), and the editors of graphs ([materials](../../packages/editor-plugin-material-graph/README.md), [animations](../../packages/editor-plugin-animation-graph/README.md), [behaviors](../../packages/editor-plugin-behavior-graph/README.md)), whose code is a chunk of its own, loaded at its first activation event; their part in the engine (`graphsExtension` of [`@fdw/graph-editor/engine`](../../packages/graph-editor/README.md)) is given to the `EditorEngine`. `src/styles.css` gives Tailwind the classes of the shell and of the plugins.
- **The scenes**: the level being edited (`level`, the first one; [the level](../../packages/editor-ui/README.md#the-level)), its images decoded by the browser (`bitmapCodec`), then those of the desktop editor, by the same names (`src/scenes.ts`); the models of the third-person game are those of the documentation, served under `/models/forest/` and copied into the build.

## The backend

`FDW_BACKEND` chooses it (design in [design/editor-ui.md §4](../../design/editor-ui.md#4-le-choix-du-backend), in French): `webgpu` by default, `webgl2`. Vite reads it at the build and in the dev server (`envPrefix`); WebGL2 is the fallback when WebGPU does not start (no `navigator.gpu`, no adapter, no device) or when the value is unknown. Each backend draws into a canvas of its own: one that got a WebGPU context can no longer give a WebGL2 one. The status bar shows the backend running, and the reason of a fallback. `FDW_SCENE` chooses the first scene.

```sh
npx nx run editor-web:dev                       # http://localhost:4300
FDW_BACKEND=webgl2 npx nx run editor-web:dev
FDW_SCENE=tps npx nx run editor-web:build       # into dist/
```

## In the documentation

The pages of the editor in the documentation show this editor, live, in frames (`Editor.astro` of `apps/docs`): `editor-web:build-docs` builds it into the site, under `/fdw-engine/editor-app/` (`apps/docs/public/editor-app`, not versioned), before the site is built; the models of the forest are those the site serves already (`FDW_MODELS`). The page tells the editor what to do by its query:

| Query             | What                                                            |
| ----------------- | --------------------------------------------------------------- |
| `?scene=<name>`   | The scene shown first, as `FDW_SCENE`                           |
| `?backend=<name>` | The backend, as `FDW_BACKEND` (`?backend=webgl2` in the tests)  |
| `?view=<id>`      | A panel shown at the start: an editor of graphs (P19)           |
| `?docks=<list>`   | The docks shown (`left,right,bottom`; none when empty)          |
| `?embed`          | Nothing kept (`memoryStorage`): the default layout at each load |

```sh
npx nx run editor-web:build-docs   # by docs:build and docs:dev
```

## Tests

The editor in headless Chromium (`src/editor.spec.tsx`), on both backends on SwiftShader, without a GPU: the first scene drawn, the canvas the size of the viewport, the fallback; the same canvas through the docks hidden and the tabs changed; the tool of the sample plugin run from the command palette, its chunk loaded then; the level: a rectangle dragged over the viewport selects (the picking read back on WebGPU), the tree selects and the inspector shows, Delete then Ctrl+Z; the storage in IndexedDB. WebGPU runs on SwiftShader by Vulkan (`--use-webgpu-adapter=swiftshader`, as the tests of the documentation): on the default adapter of headless Chromium, the readbacks never resolve. Tagged `gpu`: they run in the native job of the CI.

```sh
npx nx test editor-web
```
