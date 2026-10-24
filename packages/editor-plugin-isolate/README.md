# @fdw/editor-plugin-isolate

The plugin of the tutorial "Writing a plugin" of the documentation ([apps/docs](../../apps/docs/src/content/docs/editor/writing-a-plugin.mdx), P18 of [design/roadmap.md](../../design/roadmap.md), in French): written as a third party would, it only imports `@fdw/editor-ui` ([the plugins in its README](../editor-ui/README.md#the-plugins)). The code of the tutorial is the code of this package. Both editors give it to their shell (`EditorHost.plugins`).

```ts
import { isolatePlugin } from '@fdw/editor-plugin-isolate';

const host: EditorHost = { /* … */ plugins: [isolatePlugin] };
```

```css
/* The stylesheet of the application: its classes for Tailwind. */
@import '@fdw/editor-ui/styles.css';
@import '@fdw/editor-plugin-isolate/styles.css';
```

- **The manifest** (`src/manifest.ts`): two commands in the Edit menu, _Isolate the selection_ (`I`) and _Show everything_ (`Shift+I`), enabled by their clauses (`scene.hasSelection`, and the context key `isolate.active` of the plugin); the Statistics panel, open in the right dock of a new layout; an item of the status bar.
- **The code** (`src/main.tsx`), a chunk of its own, loaded with its panel: it reads the projection of the level (`ILevelStore`), and changes the level by the commands of the engine (`level.command`, `edit` of the visibility, each a step of the history). The nodes it hid are kept in memory only: their ids are those of a session of the engine.
- **The panel** counts the nodes by kind, those hidden (themselves or by a parent) and selected, and runs the commands; the status bar tells the nodes shown while the selection is isolated.

Tested in the shell, with a fake host (`src/isolate.spec.tsx`): the statistics and the nodes to hide, the commands and their key, the context key, the status bar, the panel. In Chromium by the documentation (`apps/docs/tests/editor.spec.ts`).

```sh
npx nx test editor-plugin-isolate
```
