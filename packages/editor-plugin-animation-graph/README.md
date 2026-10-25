# @fdw/editor-plugin-animation-graph

The editor of the animation graphs, a plugin of the editor (P19 of [design/roadmap.md](../../design/roadmap.md), in French), on [`@fdw/graph-editor`](../graph-editor/README.md). The tutorial: [Animating in the editor](../../apps/docs/src/content/docs/editor/animating-in-the-editor.mdx).

- **The manifest**: the panel **Animation graph** (`fdw.animationGraph.editor`), beside the viewport, and the command **Graphs: Edit the animations**.
- **The panel**: the animation graphs of the scene shown (the hero and the enemies of the game), live. On the canvas, the weight of each node in the pose of the animator followed, the state of each machine. A double click on a state machine opens its view (`StateMachineView`): the states and the transitions, the state playing and the fade in progress, a transition drawn from a state to another. Its tabs: **Play** (the animator followed, its parameters forced, its machines), **State machine** (the states renamed with their transitions and their input, added, removed, the initial one; the transitions, their fade, exit time, trigger and conditions: `src/stateMachine.ts`), Node, Problems.

Tested with the shell and a workspace for engine (`src/animation.spec.tsx`).
