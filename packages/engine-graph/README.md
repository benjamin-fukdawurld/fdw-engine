# @fdw/engine-graph

The graph core of FdwEngine, shared by every kind of graph: the material graphs of `@fdw/engine-shader`, the animation graphs of `@fdw/engine-animation`, the behavior graphs to come, and their editors. Typed nodes and edges as plain data, registries of node types, diagnostics, the serialization of the documents and the structural checks. No dependency. See [design/p6-animation.md](../../design/p6-animation.md) (in French).

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
- **The checks**: `resolveNodes`, `resolveEdges`, `checkParams`, `topologicalOrder`, and `validateDocument` for the graphs of simply typed ports.
- **The diagnostics**: `Diagnostic`, `formatDiagnostic`, `GraphError`.
