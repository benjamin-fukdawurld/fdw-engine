# @fdw/editor-plugin-sample

A sample plugin of the editor (step 12 of P18 in [design/roadmap.md](../../design/roadmap.md), in French), written as a third party would: it only imports `@fdw/editor-ui` ([the plugins in its README](../editor-ui/README.md#the-plugins)). Both editors give it to their shell (`EditorHost.plugins`).

```ts
import { samplePlugin } from '@fdw/editor-plugin-sample';

const host: EditorHost = { /* … */ plugins: [samplePlugin] };
```

```css
/* The stylesheet of the application: its classes for Tailwind. */
@import '@fdw/editor-ui/styles.css';
@import '@fdw/editor-plugin-sample/styles.css';
```

- **The manifest** (`src/manifest.ts`), read at the start: the Mark tool (slot `primary`), three commands (add a mark, finish, show the marks), the Marks panel in the right dock, the Marks menu, the Marks toolbar on the left, an item of the status bar, two keys (`M` adds a mark and `Ctrl+Enter` finishes, while the tool is active).
- **The code** (`src/main.tsx`), a chunk of its own (`import()`), loaded at the first event: the Mark button of the toolbar, a command of the palette, the panel shown.
- **The tool** is a machine of XState in the slot `primary`: it counts the marks until finished, then adds them to the state of the plugin (`ctx.state`, kept with the layout) and ends. Its count is kept with the layout too: reloaded with the plugin, the tool is still active, with its marks.
- **What is seen**: nothing in the viewport (the tools of the viewport, with the input routing, come at step 13); while the tool is active, the status bar shows its marks and its keys; finished, the marks placed.
- **The panel** shows the marks of the tool active (`useToolSnapshot`), those placed, and notes kept in the state of the plugin.
- **Without the plugin**, the layout that references it reloads: its panel tells its plugin is missing, the tool is idle, its state is kept.

Tested in the shell, with a fake host (`src/sample.spec.tsx`): loaded at its first event, the marks by the keys, the panel and the status bar, reloaded with and without it. In Chromium by the web editor (`apps/editor-web`).

```sh
npx nx test editor-plugin-sample
```
