import {
  Camera,
  DirectionalLight,
  Material,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import { OrbitActions, OrbitOperator } from '@fdw/engine-camera';
import {
  CreateNodeCommand,
  EditingTools,
  GizmoRenderer,
  History,
  Outline,
  Picker,
  renderablesOf,
  SceneEvents,
  Selection,
  toolPointer,
  TransformGizmo,
  Viewport,
} from '@fdw/engine-editing';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { type Node, Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { createCube, createSphere, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Select and transform the objects of a scene: click, Shift/Ctrl click, or
// drag a rectangle to select; drag the handles of the gizmo to move, rotate,
// scale; W/E/R change the tool, X the axes, C the pivot; Ctrl+Z, Ctrl+Y
// undo and redo; Delete removes. Right drag turns the camera, the wheel
// zooms.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The scene: a ground, cubes, spheres, a table made of five nodes.
  const g = new GraphBuilder('object');
  g.surface({
    shadingModel: 'phong',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const sphere = createSphere();
  const scene = new Scene();
  scene.root
    .add({
      name: 'ground',
      position: { y: -0.05 },
      scale: { x: 12, y: 0.1, z: 8 },
    })
    .setMesh(cube, material([0.42, 0.44, 0.46]));
  const objects: Node[] = [];
  [
    [-3, 0.5, 1, [0.85, 0.35, 0.25]],
    [-1.2, 0.5, -1.5, [0.3, 0.6, 0.85]],
    [3.2, 0.5, 1.5, [0.9, 0.75, 0.3]],
  ].forEach(([x, y, z, color], i) => {
    objects.push(
      scene.root
        .add({ name: `cube ${i + 1}`, position: { x: +x, y: +y, z: +z } })
        .setMesh(cube, material(color as [number, number, number])),
    );
  });
  [
    [0.4, 0.6, 1.6, [0.45, 0.8, 0.45]],
    [-3.4, 0.6, -2, [0.75, 0.45, 0.85]],
  ].forEach(([x, y, z, color], i) => {
    objects.push(
      scene.root
        .add({
          name: `sphere ${i + 1}`,
          position: { x: +x, y: +y, z: +z },
          scale: { x: 1.2, y: 1.2, z: 1.2 },
        })
        .setMesh(sphere, material(color as [number, number, number])),
    );
  });
  // A table: a group selected as a whole.
  const wood = material([0.6, 0.42, 0.28]);
  const table = scene.root.add({ name: 'table', position: { x: 2, z: -1.6 } });
  table
    .add({ position: { y: 0.9 }, scale: { x: 2, y: 0.1, z: 1.2 } })
    .setMesh(cube, wood);
  for (const [x, z] of [
    [-0.85, -0.5],
    [0.85, -0.5],
    [-0.85, 0.5],
    [0.85, 0.5],
  ]) {
    table
      .add({ position: { x, y: 0.425, z }, scale: { x: 0.1, y: 0.85, z: 0.1 } })
      .setMesh(cube, wood);
  }
  const sun = new DirectionalLight({
    direction: { x: -0.4, y: -1, z: -0.6 },
    ambient: { x: 0.25, y: 0.25, z: 0.28 },
    castShadow: true,
  });
  scene.root.add().setLight(sun);

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  // The camera: the right button turns, the middle one pans, the wheel
  // zooms. The left button and the keys are the tools'.
  const input = new Input(new WebInputSource(canvas));
  const orbit = new OrbitOperator(
    camera,
    new ActionMap(input, {
      ...OrbitActions,
      move: { type: 'vector', bindings: [] },
      orbit: { type: 'vector', bindings: [] },
      zoom: { type: 'axis', bindings: [] },
      orbitDrag: { type: 'button', bindings: ['pointer:2'] },
      panDrag: { type: 'button', bindings: ['pointer:1'] },
    }),
    { pivot: { x: 0, y: 0.5, z: 0 }, distance: 13, yaw: 0.35, pitch: -0.6 },
  );
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => event.preventDefault(), {
    passive: false,
  });
  canvas.style.touchAction = 'none';

  // The tools: the history, the selection (the objects under the root: a
  // leg selects its table, the ground is not selectable), the picker, the
  // gizmo.
  const renderer = new Renderer(backend);
  const runner = new RenderGraphRunner(backend);
  const history = new History();
  const selection = new Selection<Node>();
  const viewport = new Viewport(camera);
  const picker = Picker.forScene(backend, scene, (node) => {
    let top = node;
    while (top.parent && top.parent !== scene.root) {
      top = top.parent;
    }
    return top.name === 'ground' ? undefined : top;
  });
  const gizmo = new TransformGizmo({
    history,
    snap: { translate: 0.5, rotate: 15, scale: 0.25 },
  });
  const tools = new EditingTools({
    viewport,
    selection,
    picker,
    gizmo,
    history,
  });
  const outline = new Outline(renderer, backend);
  const gizmoRenderer = new GizmoRenderer(renderer);
  selection.set([objects[0]]);

  // The pointer and the keys, for the tools.
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus();
    if (tools.pointerDown(toolPointer(event, canvas))) {
      canvas.setPointerCapture(event.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (event) =>
    tools.pointerMove(toolPointer(event, canvas)),
  );
  canvas.addEventListener('pointerup', (event) =>
    tools.pointerUp(toolPointer(event, canvas)),
  );
  canvas.addEventListener('pointerleave', () => tools.pointerLeave());
  canvas.addEventListener('keydown', (event) => {
    if (tools.keyDown(event)) {
      event.preventDefault();
      show();
    }
  });

  // A toolbar over the canvas, and the rectangle being dragged.
  const host = canvas.parentElement as HTMLElement;
  host.style.position = 'relative';
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;left:8px;top:8px;margin:0;display:flex;gap:4px;flex-wrap:wrap;font:12px sans-serif';
  host.append(bar);
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.dataset['tool'] = label;
    element.style.cssText =
      'margin:0;padding:2px 8px;border:1px solid #666;border-radius:4px;background:#222c;color:#eee;cursor:pointer';
    element.addEventListener('click', () => {
      action();
      show();
      canvas.focus();
    });
    bar.append(element);
    return element;
  };
  const modes = (['translate', 'rotate', 'scale'] as const).map((mode) =>
    button(
      mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Scale',
      () => {
        gizmo.mode = mode;
      },
    ),
  );
  const space = button('World', () => {
    gizmo.space = gizmo.space === 'world' ? 'local' : 'world';
  });
  const pivot = button('Center', () => {
    gizmo.pivot = gizmo.pivot === 'center' ? 'origin' : 'center';
  });
  const snapping = button('Snap', () => {
    gizmo.snapping = !gizmo.snapping;
  });
  button('Undo', () => tools.undo());
  button('Redo', () => tools.redo());
  button('Add', () => {
    const create = new CreateNodeCommand(
      'Add cube',
      scene.root,
      { name: 'new cube', position: { y: 0.5 } },
      (node) => node.setMesh(cube, material([0.85, 0.85, 0.8])),
    );
    history.execute(create);
    if (create.node) {
      selection.set([create.node]);
    }
  });
  button('Delete', () => tools.deleteSelection());
  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute;margin:0;display:none;pointer-events:none;border:1px solid #6af;background:#6af3';
  host.append(box);
  tools.onChange(() => {
    const rectangle = tools.rectangle;
    box.style.display = rectangle ? 'block' : 'none';
    if (rectangle) {
      // From the pixels of the viewport back to CSS pixels.
      const ratio = canvas.clientWidth / canvas.width;
      const { from, to } = rectangle;
      box.style.left = `${canvas.offsetLeft + Math.min(from.x, to.x) * ratio}px`;
      box.style.top = `${canvas.offsetTop + Math.min(from.y, to.y) * ratio}px`;
      box.style.width = `${Math.abs(to.x - from.x) * ratio}px`;
      box.style.height = `${Math.abs(to.y - from.y) * ratio}px`;
    }
  });

  // What changed in the scene, as a panel of an editor would hear it.
  let events = '';
  new SceneEvents(scene).listen(({ created, removed, moved, modified }) => {
    events = [
      created.size && `${created.size} created`,
      removed.size && `${removed.size} removed`,
      moved.size && `${moved.size} moved`,
      modified.size && `${modified.size} modified`,
    ]
      .filter(Boolean)
      .join(', ');
    show();
  });
  const show = () => {
    modes.forEach((element, i) => {
      element.style.borderColor =
        gizmo.mode === ['translate', 'rotate', 'scale'][i] ? '#fc3' : '#666';
    });
    space.textContent = gizmo.space === 'world' ? 'World' : 'Local';
    pivot.textContent = gizmo.pivot === 'center' ? 'Center' : 'Origins';
    snapping.style.borderColor = gizmo.snapping ? '#fc3' : '#666';
    info(
      `${selection.items.map((node) => node.name).join(', ') || 'nothing'} selected · ${
        history.undoLabels.at(-1) ?? 'no change'
      }${events ? ` · ${events}` : ''}`,
    );
  };
  selection.onChange(show);
  history.onChange(show);
  show();

  let previous: number | undefined;
  onFrame((time) => {
    const dt = Math.min(0.1, time - (previous ?? time));
    previous = time;
    input.update();
    orbit.update(dt);
    followAspect(camera, surface);
    const target = surface.getCurrentTarget();
    const size = { width: target.width, height: target.height };
    viewport.resize(size.width, size.height);

    const frame = new RenderGraph({ size });
    // Each pass writes a new version of the image: the next one draws over
    // it.
    let color = renderer.addScenePasses(frame, {
      source: scene,
      camera,
      target: frame.importTexture('surface', target),
      format: surface.format,
      clearColor: { r: 0.12, g: 0.13, b: 0.15, a: 1 },
      outputs: { id: picker.output(frame, size.width, size.height) },
    }).color;
    // The object under the pointer, then the selection, outlined.
    const hovered = selection.hovered;
    if (hovered && !selection.has(hovered)) {
      color = outline.addPasses(frame, {
        name: 'hover outline',
        items: renderablesOf([hovered]),
        camera,
        target: color,
        format: surface.format,
        size,
        color: [1, 1, 1, 0.6],
        width: 1.5,
      });
    }
    color = outline.addPasses(frame, {
      items: renderablesOf(selection.items),
      camera,
      target: color,
      format: surface.format,
      size,
    });
    gizmoRenderer.addPasses(frame, gizmo, viewport, {
      target: color,
      format: surface.format,
    });
    runner.execute(frame);
    surface.present();
  });
};

export default example;
