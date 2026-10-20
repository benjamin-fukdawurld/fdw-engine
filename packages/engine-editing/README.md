# @fdw/engine-editing

The editing tools of FdwEngine, for any application that lets its users change a scene: an editor, a modeler, a configurator in a web page. The selection (click, rectangle, hover, outlines), the gizmos of translation, rotation and scale, reversible commands in a history with transactions, and the events of the scene. See [design/p15-editing.md](../../design/p15-editing.md) (in French), and the Selection, gizmos and commands tutorial of the documentation.

## Public API

| Export                                                                                              | Description                                                                                    |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Viewport`, `pointerPixel`                                                                          | A camera and a size in pixels: the ray under a pixel, projections, the size of a pixel         |
| `Picker`                                                                                            | The objects under a pixel or in a rectangle, by the texture of identifiers of the scene passes |
| `Selection`, `selectionMode`                                                                        | The selected objects (the last one active), the hovered one; the mode from the modifiers       |
| `Outline`, `renderablesOf`                                                                          | Outlines around objects over the image: a mask, then a full screen pass                        |
| `TransformGizmo`, `GizmoRenderer`                                                                   | The gizmo: by axis, plane, screen or uniform; world or local; pivot; snapping; constant size   |
| `hitHandles`, `raySegmentDistance`, `rayCircleDistance`, `rayPlane`                                 | The analytic hit tests of the handles, on the CPU                                              |
| `History`, `Command`, `CommandGroup`, `defineCommand`                                               | Undo and redo, transactions, merged steps, a limit                                             |
| `TransformCommand`, `PropertyCommand`, `CreateNodeCommand`, `DeleteNodesCommand`, `ReparentCommand` | The commands of a scene                                                                        |
| `SceneTrash`                                                                                        | The hidden branch where removed nodes wait to come back                                        |
| `SceneEvents`                                                                                       | Created, removed, moved, modified: the changes of a scene in batches                           |
| `EditingTools`, `toolPointer`                                                                       | All of it on the pointer (mouse and touch) and the keyboard                                    |

## Usage

```ts
import {
  EditingTools,
  GizmoRenderer,
  History,
  Outline,
  Picker,
  renderablesOf,
  Selection,
  toolPointer,
  TransformGizmo,
  Viewport,
} from '@fdw/engine-editing';

const history = new History();
const selection = new Selection<Node>();
const viewport = new Viewport(camera);
const picker = Picker.forScene(backend, scene);
const gizmo = new TransformGizmo({ history });
const tools = new EditingTools({ viewport, selection, picker, gizmo, history });
canvas.addEventListener('pointerdown', (e) =>
  tools.pointerDown(toolPointer(e, canvas)),
);
canvas.addEventListener('pointermove', (e) =>
  tools.pointerMove(toolPointer(e, canvas)),
);
canvas.addEventListener('pointerup', (e) =>
  tools.pointerUp(toolPointer(e, canvas)),
);
canvas.addEventListener(
  'keydown',
  (e) => tools.keyDown(e) && e.preventDefault(),
);

// Each frame: the scene with its identifiers, the outline, the gizmo.
viewport.resize(width, height);
renderer.addScenePasses(graph, {
  source: scene,
  camera,
  target,
  format,
  outputs: { id: picker.output(graph, width, height) },
});
outline.addPasses(graph, {
  items: renderablesOf(selection.items),
  camera,
  target,
  format,
  size,
});
gizmoRenderer.addPasses(graph, gizmo, viewport, { target, format });
```

- **The gizmo is tested on the CPU**: the ray under the pointer against the axes, the squares of the planes and the rings, in the space of the gizmo; no read back.
- **A drag is one entry** of the history: the targets move at each step, one `TransformCommand` is recorded at the end.
- **Removed nodes are kept** in a hidden branch out of the tree (`SceneTrash`), with their entity: undone, they come back as they were.
- **The events** are built on `scene.observe()` of `@fdw/engine-scene`.
