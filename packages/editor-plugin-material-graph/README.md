# @fdw/editor-plugin-material-graph

The editor of the material graphs, a plugin of the editor (P19 of [design/roadmap.md](../../design/roadmap.md), in French), on [`@fdw/graph-editor`](../graph-editor/README.md). The tutorial: [Editing a material](../../apps/docs/src/content/docs/editor/editing-a-material.mdx).

```ts
import { materialGraphPlugin } from '@fdw/editor-plugin-material-graph';

const host: EditorHost = { /* … */ plugins: [materialGraphPlugin] };
// The engine of the host: extensions: [graphsExtension()].
```

- **The manifest**: the panel **Material graph** (`fdw.materialGraph.editor`), beside the viewport (`split: 'right'`), and the command **Graphs: Edit the materials**.
- **The panel**: the materials of the scene shown (those of the level, of the gallery), live; a file or a new material. Its tabs: **Preview** (the material drawn by the engine on a sphere, a cube or a plane, animated or not), **Code** (the code generated for the backend, the lines of the node selected highlighted, a click on a line selects its node), Node, Problems; the nodes the compilation finds wrong outlined.

Tested with the shell and a workspace for engine (`src/material.spec.tsx`): a material of the scene edited live and undone, a connection refused, a new graph.
