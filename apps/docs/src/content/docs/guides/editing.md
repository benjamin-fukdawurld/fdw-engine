---
title: Editing tools
description: The selection, the gizmos, the commands and the events of the scene, for the applications that edit a scene.
sidebar:
  order: 16
---

`@fdw/engine-editing` holds the tools of an application that edits a
scene: an editor, a modeler, a configurator in a web page. Each piece is
usable alone; `EditingTools` puts them together on the pointer and the
keyboard. The [tutorial](/fdw-engine/tutorials/editing/) builds a scene
editor with them, step by step.

| Export                                                                                              | What it is                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `Viewport`, `pointerPixel`                                                                          | A camera and a size in pixels: rays, projections, size of a pixel    |
| `Picker`                                                                                            | Objects under a pixel or in a rectangle, by a texture of identifiers |
| `Selection`, `selectionMode`                                                                        | The selected objects, the active one, the hovered one                |
| `Outline`, `renderablesOf`                                                                          | Outlines over the image                                              |
| `TransformGizmo`, `GizmoRenderer`                                                                   | The gizmo of translation, rotation and scale, and its drawing        |
| `hitHandles`, `raySegmentDistance`, `rayCircleDistance`, `rayPlane`                                 | The hit tests of the handles, on the CPU                             |
| `History`, `Command`, `CommandGroup`, `defineCommand`                                               | The history of the reversible changes                                |
| `TransformCommand`, `PropertyCommand`, `CreateNodeCommand`, `DeleteNodesCommand`, `ReparentCommand` | The commands of the scene                                            |
| `SceneTrash`                                                                                        | Where the removed nodes wait, to come back                           |
| `SceneEvents`                                                                                       | The changes of a scene, in batches                                   |
| `EditingTools`, `toolPointer`                                                                       | All of it on the pointer and the keyboard                            |

## What is edited

The tools move **editables**: the nodes of a `Scene`, or bare `Transform`s
(items drawn without a scene). A node moves in the space of its parent;
selected with one of its ancestors, it moves once, with it (`topmost`). A
node is **alive** while it is in its scene: not destroyed, nor in the
trash (`isAlive`).

## Viewport

| Member                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `new Viewport(camera, w, h)`  | The camera is read at each call                                 |
| `resize(width, height)`       | The size of the target, in pixels                               |
| `ray(point)`                  | The ray through a pixel (perspective and orthographic)          |
| `project(point)`              | `{ x, y, depth }`: the pixel of a point of the world, its depth |
| `worldPerPixel(point)`        | The size of a pixel at a point, in units of the world           |
| `direction(point)`, `forward` | From the camera to a point; where the camera looks              |

The pixels count from the top left corner of the target. The aspect of
the camera is its projection's (keep it equal to the target's).

## Picker

`new Picker(backend, resolve)`, or `Picker.forScene(backend, scene,
resolve?)`. `output(graph, width, height)` gives the `'object-id'` output
of the scene passes, into a `r32uint` texture the picker owns (recreated
when the size changes). `pick(point)` and `pickRect(from, to)` read it
back, a frame or two later; `resolve` maps the identifiers to the objects
selected (`undefined`: not selectable).

## Selection

| Member                                    | Description                                                |
| ----------------------------------------- | ---------------------------------------------------------- |
| `items`, `size`, `active`, `has(item)`    | The selected objects, in order; the active one is the last |
| `apply(items, mode)`                      | `'replace'`, `'add'`, `'remove'`, `'toggle'`               |
| `set`, `add`, `remove`, `toggle`, `clear` | The same, by name                                          |
| `filter(keep)`                            | Keeps the objects accepted (those still in the scene)      |
| `hovered`                                 | The object under the pointer                               |
| `onChange`, `onHover`                     | Listeners; they return a function that stops               |

`selectionMode(modifiers)`: Ctrl or Cmd toggles, Shift adds, Alt removes,
none replaces.

## Outline

`new Outline(renderer, backend)`, then `addPasses(graph, options)` each
frame: `items`, `camera`, `target`, `format`, `size`, `color` (RGBA, in
the encoding of the target; orange by default), `width` (pixels, 2),
`name` (one per outline of a frame). Two passes: the items into an
`r8unorm` mask (their alpha), then a full screen pass blending the line
over the target, where the mask has an edge (16 samples on two rings). It
returns the version of the target written, for the passes after it (the
target itself, when there are no items: nothing is drawn).

## TransformGizmo

| Option, member                         | Description                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `mode`                                 | `'translate'`, `'rotate'`, `'scale'`                                              |
| `space`                                | `'world'` or `'local'` (the axes of the active object); the scale is always local |
| `pivot`                                | `'center'` (of the bounds of the selection) or `'origin'` (of each object)        |
| `snap`, `snapping`                     | Steps: `translate` (units), `rotate` (degrees), `scale` (a factor); on or off     |
| `size`                                 | The length of the axes on screen, in pixels (110)                                 |
| `history`                              | Where the drags are recorded                                                      |
| `targets`                              | What it transforms; the last one is active                                        |
| `visible`, `shown`                     | Hidden by the application; shown (visible, with targets)                          |
| `hovered`, `active`, `dragging`        | The handle under the pointer, the one dragged                                     |
| `frame(viewport)`                      | Its origin, axes, rotation and scale in the world                                 |
| `hitTest(viewport, point, tolerance?)` | The handle under a pixel (8 pixels of tolerance)                                  |
| `hover(viewport, point)`               | Updates `hovered`                                                                 |
| `begin`, `drag`, `end`, `cancel`       | A drag: `end()` records one `TransformCommand`; `cancel()` puts back              |

The handles (`GizmoHandle`): `x`, `y`, `z` (an axis, a ring), `yz`, `zx`,
`xy` (a plane), `view` (the plane of the screen; the ring around the
view), `uniform` (the center of the scale). Their sizes, in units of the
gizmo (axes 1 long), are in `GizmoShape`. Axes seen end on (closer than
14° to the view) and planes seen edge on are hidden.

How a drag moves the targets:

- **Along an axis**: the point of the axis nearest to the ray under the
  pointer; **in a plane**: where the ray crosses it.
- **Around a ring**: the angle between the vectors from the pivot to where
  the ray crosses its plane, summed step by step (more than half a turn
  is kept); a ring seen edge on follows the pointer along its tangent on
  screen instead.
- **Scale**: dragging by the length of an axis doubles; the uniform handle
  follows the pointer to the right and up.
- The targets are written from their state at the start of the drag: no
  drift, `cancel()` exact.

`GizmoRenderer(renderer, { colors })`: `items(gizmo, viewport)` for the
render items, `addPasses(graph, gizmo, viewport, { target, format, name
})` for scene passes over the target, with a depth of their own, unlit,
without shadows; it returns the version of the target written. During a
drag, only the handle dragged is drawn.

## History and commands

A `Command` has a `label`, `do()`, `undo()`, and optionally `merge(next)`
(absorb the next command) and `dispose(undone)` (free what it keeps when
the history drops it).

| `History` member                                 | Description                                                   |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `execute(command)`                               | Does and records (in the open transaction, if any)            |
| `record(command)`                                | Records a command already done                                |
| `begin(label)`, `commit()`, `cancel()`           | A transaction: one entry; nested, only the outermost makes it |
| `transaction(label, body)`                       | Commits when `body` returns, cancels when it throws           |
| `undo()`, `redo()`                               | False when there is nothing to undo or redo                   |
| `canUndo`, `canRedo`, `undoLabels`, `redoLabels` | For the menus                                                 |
| `clear()`, `limit`, `onChange`                   | Forget everything; the entries kept (100); a listener         |

| Command                                             | Does                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `TransformCommand(label, targets, before, after)`   | Sets local transforms; `capture(targets)` reads them             |
| `PropertyCommand(label, { get, set }, value, key?)` | Sets a value; merges with the next of the same `key`             |
| `CreateNodeCommand(label, parent, options, build?)` | Creates a node, set up once by `build`; `node`                   |
| `DeleteNodesCommand(label, nodes)`                  | Removes nodes and their branches                                 |
| `ReparentCommand(label, nodes, parent)`             | Moves nodes under another parent, keeping their local transforms |
| `CommandGroup(label, commands)`                     | Commands done in order, undone in reverse                        |

The removed nodes go to the `SceneTrash` of their scene: a hidden branch
out of the tree, so they keep their entity, their components and their
handles. `CreateNodeCommand` undone, `DeleteNodesCommand` done, the history
destroys them when it drops the command.

## SceneEvents

`new SceneEvents(scene, { delivery })`: `'microtask'` (the default)
delivers after the code that made the changes; `'manual'` at `flush()`.
`listen(listener)` receives `{ created, removed, moved, modified }`, sets
of entities. Built on `scene.observe()` (see the
[scene graph guide](/fdw-engine/guides/scene-graph/#observers)); the nodes
going to the trash are removed, those coming back created (or moved, in
the same batch). `dispose()` stops.

## EditingTools

`new EditingTools({ viewport, selection, picker?, gizmo?, history?,
dragThreshold?, tolerance? })`:

- `pointerDown(pointer)`: grabs a handle, or starts a selection; returns
  whether it follows the pointer (only the primary button);
  `pointerMove`, `pointerUp`, `pointerLeave`;
- `rectangle`: the rectangle being dragged, `onChange` to redraw it;
- `keyDown(key)`: W, E, R, X, C, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Delete,
  Backspace, Escape; returns whether the key was used;
- `undo()`, `redo()`, `cancel()`, `deleteSelection()`.

`toolPointer(event, canvas)` turns a pointer event into what they read.
`tolerance` is 8 pixels for a mouse, 20 for a finger; a finger does not
hover.
