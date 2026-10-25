# @fdw/graph-editor

The editor of graphs of FdwEngine, in the page (P19 of [design/roadmap.md](../../design/roadmap.md), design in [design/p19-graph-editor.md](../../design/p19-graph-editor.md), in French): the canvas, the search, the inspector, the panel the plugins of the graphs build on, the client of the engine; and `./engine`, the part that runs with the engine. The plugins: [materials](../editor-plugin-material-graph/README.md), [animations](../editor-plugin-animation-graph/README.md), [behaviors](../editor-plugin-behavior-graph/README.md).

```tsx
import { GraphClient, GraphPanel } from '@fdw/graph-editor';

const client = new GraphClient(connection, 'acme.graph', 'behavior');
<GraphPanel client={client} title="Behavior graph" extension=".behavior.json"
  accepts={(from, to) => from === to} tabs={[…]} overlay={…} />;
```

```ts
// The engine of a host (EditorEnginePlatform.extensions).
import { graphsExtension } from '@fdw/graph-editor/engine';
new EditorEngine({ ...platform, extensions: [graphsExtension()] }, scene);
```

```css
@import '@fdw/graph-editor/styles.css';
```

- **`GraphCanvas`**: the nodes in HTML, the wires in SVG, at the geometry of `engine-graph` (`nodeSize`, `portPosition`: no measure of the page). The view moves by the middle or the right button, zooms at the wheel; selection by click (Shift adds, Ctrl toggles) and rectangle; nodes, notes and groups dragged; wires dragged between ports (those that fit grow, by the hint of the kind), into the void the search filtered on the nodes that take them; Alt+click disconnects. The keys: Delete, Ctrl+C, X, V, D, A, Z, Y, F, Home, Space or Tab (search), Ctrl+F (find), N (note), Ctrl+G and Ctrl+Shift+G (group); the others go to the editor (the keys of the plugins). The `GraphOverlay` shows the running graph: classes, badges, weights, values, markers, active wires.
- **`NodeSearch`**: by words, in the titles first, then categories, details, keywords. **`NodeInspector`**: the label, the parameters by their kind (a choice, a number, a vector by component, JSON), the values of the inputs not connected, the problems.
- **`GraphPanel`**: the bar (the graph shown among those of the scene, new, open and save through the host, undo and redo, arrange, frame, the function shown, the problems counted, live), the canvas or a view of the plugin (`override`), the column of tabs (those of the plugin, Node, Problems), the messages of the engine.
- **`GraphClient`**: a session in the engine (the extension `fdw.graphs`), opened on a graph of the scene, a file or a new graph, again when the engine restarts; what the engine tells, as a store (`useGraphClient`).
- **`graphsExtension`** (`./engine`): the `GraphWorkspace` of `@fdw/engine-graph-editing` on the graphs of the scene shown (read again twice a second), its previews drawn by the backend of the engine; it holds the scene while a debugger stops it.
- **`./testing`**: `renderGraphEditor` (the shell, its engine a workspace on targets), `stubGraphDom` (PointerEvent and canvases for jsdom).

Tested in jsdom (`src/GraphCanvas.spec.tsx`): the drawing, the moves, the connections and their hints, the search for a wire dropped, copy and paste, groups and notes, the overlay.

```sh
npx nx test graph-editor
```
