# @fdw/engine-graph-editing

The editing of the graphs of FdwEngine, on the side of the engine (P19 of [design/roadmap.md](../../design/roadmap.md), design in [design/p19-graph-editor.md](../../design/p19-graph-editor.md), in French): the sessions of the editors, the three kinds of graphs (materials, animations, behaviors), the graphs of a scene changed while it runs, the previews of the materials. No DOM, no React: the page of the editor ([`@fdw/graph-editor`](../graph-editor/README.md)) shows what it tells, through the messages of [`protocol.ts`](src/protocol.ts).

```ts
import {
  behaviorGraphKind,
  GraphSession,
  GraphWorkspace,
} from '@fdw/engine-graph-editing';

const session = new GraphSession('s1', behaviorGraphKind(registry), graph);
session.execute({ op: 'add', template: 'var.get:anger', at: { x: 0, y: 0 } });
session.execute({ op: 'undo' });
session.projection(); // GraphView: nodes, ports, edges, layout, diagnostics

const workspace = new GraphWorkspace({ post, backend, meshes });
workspace.setTargets(scene.graphs ?? []);
workspace.receive(request); // GraphRequest, from the page
workspace.frame(time); // compilations, previews, live states
```

- **The kinds** (`GraphKind`): `materialGraphKind(registry?)`, `animationGraphKind(registry?)`, `behaviorGraphKind(registry)`. Each parses and writes its documents, makes a new one, gives its scopes (the graph and its functions), validates a scope (the ports of each node, their types as text, the diagnostics), its catalog of templates (a type and parameters: `Get anger`, `vec3 constant`, `surface (pbr)`), the fields of the document (variables, parameters, signatures), the edits of its functions; the parameters as the editor writes them (the types of the shaders by name).
- **The sessions** (`GraphSession`): a document, its `History` (the commands of P15: a snapshot before and after, the moves of the same nodes and the typing in the same field merged), the scope shown; `execute(GraphCommand)` (add a node from a template, connected to a port; remove; connect, refused when it adds an error on its nodes; disconnect; move; parameters, defaults, labels; notes and groups; paste; arrange; fields; functions; undo, redo, scope); `projection()`. The nodes without position are placed by `autoLayout`.
- **The targets** (`GraphTarget`, `Scene.graphs`): a material of objects (`itemsMaterialTarget`), the graph of animators (`animatorsTarget`, `Animator.setGraph`), the graph of a `BehaviorSystem` (`setGraph`, its debugger). `applyGraph` runs a graph in its target.
- **The workspace** (`GraphWorkspace`): the sessions of the editors, bound to targets or to documents of their own; each valid change runs in its target (a material once compiled); the material compiled by `compileMaterial`, its code for the backend and its source map (`materialCode`, `sourceMap`: the lines marked `// #id`, those of a macro brought back to the macro), its preview (`MaterialPreview`: a sphere, a cube or a plane drawn into a texture and read back); the states of the animator followed (`Animator.inspect`); the debugger (`debugState`, `setBreakpoint`: the nodes of a function at each of its calls, `callPrefixes`). `paused` holds the scene while a debugger stops it.

Tested (`src/session.spec.ts`, `src/workspace.spec.ts`): the three kinds, the commands and the history, the refused connections, the functions; the workspace on a backend without GPU writing WGSL (the code, its source map, the preview), animators, a behavior system debugged.

```sh
npx nx test engine-graph-editing
```
