# @fdw/editor-plugin-behavior-graph

The editor and the debugger of the behavior graphs, a plugin of the editor (P19 of [design/roadmap.md](../../design/roadmap.md), in French), on [`@fdw/graph-editor`](../graph-editor/README.md). The tutorial: [Debugging a behavior](../../apps/docs/src/content/docs/editor/debugging-a-behavior.mdx).

- **The manifest**: the panel **Behavior graph** (`fdw.behaviorGraph.editor`), beside the viewport; the **Debug** menu: Continue (**F5**), Step (**F10**), a breakpoint on the node selected (**F9**), Stop (**Shift+F5**), the keys while the panel has the focus; the context keys `behavior.debugging` and `behavior.paused`.
- **The panel**: the behavior graphs of the scene shown (the mind of the enemies of the game), live. Its tabs: **Debugger** (open it; the instance followed; continue, step; where the graph stopped, the scene waiting; the variables; the runs and values of the node selected), **Variables**, **Functions** (functions and macros made, shown, their signature), Node, Problems. On the canvas: breakpoints, the node stopped before, the runs and the last values of each node, the wires of the flow that ran. A double click on a call shows the body of its function.

Tested with the shell and a workspace for engine (`src/behavior.spec.tsx`): a breakpoint, the pause, a step; the variables and the functions.
