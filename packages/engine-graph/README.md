# @fdw/engine-graph

The graph core of FdwEngine, shared by every kind of graph: the material graphs of `@fdw/engine-shader`, the animation graphs of `@fdw/engine-animation`, the behavior graphs of `@fdw/engine-behavior`, and their editors. Typed nodes and edges as plain data, registries of node types, diagnostics, the serialization of the documents and the structural checks. No dependency. See [design/p6-animation.md](../../design/p6-animation.md) (in French).

```ts
import { Registry, validateDocument, type NodeType } from '@fdw/engine-graph';

const value: NodeType = {
  id: 'value',
  params: { value: { kind: 'number', required: true } },
  inputs: () => [],
  outputs: () => [{ name: 'out', type: 'number' }],
};
const result = validateDocument(graph, {
  registry: new Registry([value, sum]),
});
result.valid; // result.diagnostics, result.order
```

- **The model**: `GraphNode`, `PortRef`, `GraphEdge`, `GraphDocument`; `parseDocument` and `serializeDocument` check the format, the version, the nodes and the edges.
- **The checks**: `resolveNodes`, `resolveEdges` (as many edges per port as its `connections` allow), `checkParams`, `topologicalOrder`, and `validateDocument` for the graphs of simply typed ports (`flow`: the edges of the control flow, which may loop).
- **The diagnostics**: `Diagnostic` (its `scope`: the function of the document holding the node), `formatDiagnostic`, `GraphError`.
- **The layout** (`layout.ts`, P19): `GraphLayout` in the document (`layout`: the positions of the nodes, the notes, the groups), ignored by the validation; `nodeSize` and `portPosition`, the geometry shared by the editor and the layout; `autoLayout`, the nodes in columns from the sources, for the graphs made in code.
- **The edits** (`edit.ts`, P19): pure functions of a `GraphBody` (the nodes, the edges and the layout of a document or of a function): `addNode`, `removeNodes`, `connect` (replacing the edges a port cannot keep), `disconnect`, `setParams`, `setDefault`, `setLabel`, `moveNodes`, `addNote`, `editNote`, `groupNodes`, `editGroup`, `removeDecorations`, `copyFragment`, `pasteFragment`, `uniqueNodeId`. The editors of `@fdw/engine-graph-editing` are made of them.
