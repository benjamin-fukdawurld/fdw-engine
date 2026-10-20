import { Camera, Transform } from '@fdw/engine-core';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  CreateNodeCommand,
  DeleteNodesCommand,
  defineCommand,
  EditingTools,
  History,
  hitHandles,
  PropertyCommand,
  raySegmentDistance,
  ReparentCommand,
  type SceneChanges,
  SceneEvents,
  Selection,
  selectionMode,
  TransformCommand,
  TransformGizmo,
  Viewport,
} from './index';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, digits = 4) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]).toBeCloseTo(b[i], digits);
  }
};

// A camera at (0, 0, 10) looking at the origin, 45° of field, a square
// viewport of 400 pixels.
function viewport(): Viewport {
  const camera = new Camera({
    position: { x: 0, y: 0, z: 10 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 1,
      near: 0.1,
      far: 100,
    },
  });
  return new Viewport(camera, 400, 400);
}

describe('History', () => {
  const counter = () => {
    const state = { value: 0 };
    const add = (n: number) =>
      defineCommand(
        `add ${n}`,
        () => (state.value += n),
        () => (state.value -= n),
      );
    return { state, add };
  };

  it('undoes and redoes, and drops what was undone on a new command', () => {
    const { state, add } = counter();
    const history = new History();
    history.execute(add(1));
    history.execute(add(2));
    expect(state.value).toBe(3);
    expect(history.undo()).toBe(true);
    expect(state.value).toBe(1);
    expect(history.redoLabels).toEqual(['add 2']);
    expect(history.redo()).toBe(true);
    expect(state.value).toBe(3);
    history.undo();
    history.execute(add(10));
    expect(history.canRedo).toBe(false);
    expect(history.undoLabels).toEqual(['add 1', 'add 10']);
    expect(history.redo()).toBe(false);
  });

  it('groups a transaction into one entry, and cancels it', () => {
    const { state, add } = counter();
    const history = new History();
    history.transaction('both', () => {
      history.execute(add(1));
      history.execute(add(2));
    });
    expect(history.undoLabels).toEqual(['both']);
    history.undo();
    expect(state.value).toBe(0);
    history.redo();
    expect(state.value).toBe(3);

    history.begin('dropped');
    history.execute(add(5));
    expect(history.canUndo).toBe(false);
    history.cancel();
    expect(state.value).toBe(3);
    expect(history.undoLabels).toEqual(['both']);

    expect(() =>
      history.transaction('failed', () => {
        history.execute(add(7));
        throw new Error('no');
      }),
    ).toThrow('no');
    expect(state.value).toBe(3);
  });

  it('nests transactions and keeps a limit', () => {
    const { add } = counter();
    const history = new History({ limit: 2 });
    history.transaction('outer', () => {
      history.execute(add(1));
      history.transaction('inner', () => history.execute(add(2)));
    });
    expect(history.undoLabels).toEqual(['outer']);
    history.execute(add(3));
    history.execute(add(4));
    expect(history.undoLabels).toEqual(['add 3', 'add 4']);
  });

  it('merges the steps of a property of the same key', () => {
    const target = { value: 0 };
    const access = {
      get: () => target.value,
      set: (v: number) => (target.value = v),
    };
    const history = new History();
    let changes = 0;
    history.onChange(() => changes++);
    for (const v of [1, 2, 3]) {
      history.execute(new PropertyCommand('Value', access, v, 'value'));
    }
    expect(history.undoLabels).toEqual(['Value']);
    expect(changes).toBe(3);
    history.undo();
    expect(target.value).toBe(0);
    history.redo();
    expect(target.value).toBe(3);
  });
});

describe('Commands on a scene', () => {
  it('creates, removes and puts back nodes, keeping their entity', () => {
    const scene = new Scene();
    const history = new History();
    const create = new CreateNodeCommand('Create', scene.root, {
      name: 'box',
      position: { x: 1 },
    });
    history.execute(create);
    const node = create.node as NonNullable<typeof create.node>;
    expect(scene.find('box')).toBe(node);
    history.undo();
    expect(scene.find('box')).toBeUndefined();
    expect(node.alive).toBe(true);
    history.redo();
    expect(scene.find('box')).toBe(node);

    history.execute(new DeleteNodesCommand('Delete', [node]));
    expect(scene.find('box')).toBeUndefined();
    history.undo();
    expect(scene.find('box')).toBe(node);
    expect(node.worldPosition.x).toBeCloseTo(1);

    // Dropped by the history after being done: destroyed for good.
    history.redo();
    history.clear();
    expect(node.alive).toBe(false);
  });

  it('moves transforms and parents', () => {
    const scene = new Scene();
    const a = scene.root.add({ name: 'a', position: { x: 2 } });
    const b = scene.root.add({ name: 'b' });
    const history = new History();
    const before = TransformCommand.capture([a]);
    a.transform.position = { x: 5 };
    history.record(
      new TransformCommand('Move', [a], before, TransformCommand.capture([a])),
    );
    history.undo();
    expect(a.transform.position.x).toBe(2);
    history.redo();
    expect(a.transform.position.x).toBe(5);

    history.execute(new ReparentCommand('Parent', [a], b));
    expect(a.parent).toBe(b);
    history.undo();
    expect(a.parent).toBe(scene.root);
  });
});

describe('SceneEvents', () => {
  it('batches the changes, removals and trash included', () => {
    const scene = new Scene();
    const events = new SceneEvents(scene, { delivery: 'manual' });
    const batches: SceneChanges[] = [];
    events.listen((changes) => batches.push(changes));

    const a = scene.root.add({ name: 'a' });
    const b = scene.root.add({ name: 'b' });
    events.flush();
    expect([...batches[0].created]).toEqual([a.entity, b.entity]);
    expect(batches[0].moved.size).toBe(0);

    a.transform.position = { x: 1 };
    b.name = 'bee';
    events.flush();
    expect([...batches[1].moved]).toEqual([a.entity]);
    expect([...batches[1].modified]).toEqual([b.entity]);

    const history = new History();
    history.execute(new DeleteNodesCommand('Delete', [a]));
    events.flush();
    expect([...batches[2].removed]).toEqual([a.entity]);
    history.undo();
    events.flush();
    expect([...batches[3].created]).toEqual([a.entity]);
    expect(batches[3].moved.size).toBe(0);

    // Created and removed in one batch: never seen.
    scene.root.add({ name: 'c' }).remove();
    events.flush();
    expect(batches).toHaveLength(4);
  });

  it('delivers after the code that made the changes', async () => {
    const scene = new Scene();
    const events = new SceneEvents(scene);
    const batches: SceneChanges[] = [];
    events.listen((changes) => batches.push(changes));
    const a = scene.root.add();
    a.transform.position = { y: 2 };
    expect(batches).toHaveLength(0);
    await Promise.resolve();
    expect(batches).toHaveLength(1);
    expect(batches[0].created.has(a.entity)).toBe(true);
    expect(batches[0].moved.size).toBe(0);
  });
});

describe('Selection', () => {
  it('replaces, adds, removes and toggles; the last is active', () => {
    const selection = new Selection<string>();
    let changes = 0;
    selection.onChange(() => changes++);
    selection.set(['a', 'b']);
    selection.apply(['c'], 'add');
    expect(selection.items).toEqual(['a', 'b', 'c']);
    expect(selection.active).toBe('c');
    selection.apply(['a'], 'add');
    expect(selection.active).toBe('a');
    selection.apply(['b', 'd'], 'toggle');
    expect(selection.items).toEqual(['c', 'a', 'd']);
    selection.apply(['c'], 'remove');
    expect(selection.items).toEqual(['a', 'd']);
    selection.set(['a', 'd']);
    expect(changes).toBe(5);
  });

  it('reads the mode from the modifiers', () => {
    expect(selectionMode({})).toBe('replace');
    expect(selectionMode({ shiftKey: true })).toBe('add');
    expect(selectionMode({ ctrlKey: true })).toBe('toggle');
    expect(selectionMode({ metaKey: true, shiftKey: true })).toBe('toggle');
    expect(selectionMode({ altKey: true })).toBe('remove');
  });
});

describe('Viewport', () => {
  it('casts rays through pixels and projects points back', () => {
    const view = viewport();
    const center = view.ray({ x: 200, y: 200 });
    close(center.origin, [0, 0, 10]);
    close(center.direction, [0, 0, -1]);
    const point = view.project([1, 2, 0]);
    const ray = view.ray(point);
    close(ray.at(10 / -ray.direction[2]), [1, 2, 0]);
    expect(point.depth).toBeCloseTo(10);
    // The top edge of the view, at a distance of 10.
    expect(view.worldPerPixel([0, 0, 0]) * 200).toBeCloseTo(
      10 * Math.tan(Math.PI / 8),
    );
  });

  it('works in orthographic', () => {
    const camera = new Camera({
      position: { x: 0, y: 0, z: 5 },
      projection: {
        type: 'orthographic',
        left: -4,
        right: 4,
        bottom: -2,
        top: 2,
        near: 0.1,
        far: 50,
      },
    });
    const view = new Viewport(camera, 800, 400);
    const ray = view.ray({ x: 600, y: 100 });
    close(ray.origin, [2, 1, 5]);
    close(ray.direction, [0, 0, -1]);
    const p = view.project([2, 1, 0]);
    expect(p.x).toBeCloseTo(600);
    expect(p.y).toBeCloseTo(100);
    expect(view.worldPerPixel([0, 0, 0])).toBeCloseTo(0.01);
  });
});

describe('Gizmo handles', () => {
  it('measures a ray against a segment', () => {
    const hit = raySegmentDistance(
      [0, 1, 5],
      [0, 0, -1],
      [-1, 0, 0],
      [1, 0, 0],
    );
    expect(hit.distance).toBeCloseTo(1);
    expect(hit.along).toBeCloseTo(5);
    // Past the end of the segment.
    expect(
      raySegmentDistance([3, 0, 5], [0, 0, -1], [-1, 0, 0], [1, 0, 0]).distance,
    ).toBeCloseTo(2);
  });

  it('finds the handle under a ray, in the space of the gizmo', () => {
    const down: [number, number, number] = [0, 0, -1];
    const at = (x: number, y: number) =>
      hitHandles('translate', [x, y, 10], down, down, 0.05)?.handle;
    expect(at(0.6, 0.01)).toBe('x');
    expect(at(0.01, 0.9)).toBe('y');
    expect(at(0.4, 0.4)).toBe('xy');
    expect(at(0, 0)).toBe('view');
    expect(at(0.7, 0.7)).toBeUndefined();
    // Seen along x: the plane yz faces the view, x is end on (hidden).
    const side: [number, number, number] = [-1, 0, 0];
    expect(
      hitHandles('translate', [10, 0.4, 0.4], side, side, 0.05)?.handle,
    ).toBe('yz');
    expect(
      hitHandles('translate', [10, 0, 0.01], side, side, 0.05)?.handle,
    ).toBe('view');

    const ring = (x: number, y: number) =>
      hitHandles('rotate', [x, y, 10], down, down, 0.05)?.handle;
    expect(ring(Math.SQRT1_2, Math.SQRT1_2)).toBe('z');
    expect(ring(0, 1.2)).toBe('view');
    // The ring of x, edge on: the vertical line through the center.
    expect(ring(0, 0.5)).toBe('x');
    expect(hitHandles('scale', [0, 0, 10], down, down, 0.05)?.handle).toBe(
      'uniform',
    );
  });
});

describe('TransformGizmo', () => {
  // A gizmo on one node at the origin, 100 pixels long: 1 unit of the
  // gizmo is 100 pixels.
  const setup = (mode: 'translate' | 'rotate' | 'scale' = 'translate') => {
    const scene = new Scene();
    const node = scene.root.add({ name: 'box' });
    const view = viewport();
    const history = new History();
    const gizmo = new TransformGizmo({ mode, size: 100, history });
    gizmo.targets = [node];
    return { scene, node, view, history, gizmo };
  };

  it('keeps a constant size on screen', () => {
    const { view, gizmo, node } = setup();
    const near = gizmo.frame(view)?.scale ?? NaN;
    node.transform.position = { z: -10 };
    expect(gizmo.frame(view)?.scale).toBeCloseTo(near * 2);
  });

  it('moves along an axis, one entry in the history', () => {
    const { view, gizmo, node, history } = setup();
    // The x axis, half way: 50 pixels right of the center.
    expect(gizmo.hitTest(view, { x: 250, y: 200 })).toBe('x');
    expect(gizmo.begin(view, { x: 250, y: 200 })).toBe(true);
    const step = view.worldPerPixel([0, 0, 0]);
    gizmo.drag(view, { x: 270, y: 230 });
    expect(node.transform.position.y).toBe(0);
    gizmo.drag(view, { x: 300, y: 200 });
    // Only along x, by the 50 pixels moved on it.
    close(node.transform.position.asArray(), [50 * step, 0, 0]);
    gizmo.end();
    expect(history.undoLabels).toEqual(['Move']);
    history.undo();
    close(node.transform.position.asArray(), [0, 0, 0]);
  });

  it('snaps, and cancels', () => {
    const { view, gizmo, node } = setup();
    gizmo.snap = { translate: 1 };
    gizmo.begin(view, { x: 250, y: 200 });
    gizmo.drag(view, { x: 330, y: 200 }, { invertSnap: true });
    const x = node.transform.position.x;
    expect(Math.abs(x - Math.round(x))).toBeLessThan(1e-6);
    // 80 pixels: 1.66 units, snapped to 2.
    expect(x).toBe(2);
    gizmo.cancel();
    expect(node.transform.position.x).toBe(0);
  });

  it('moves in a plane and in the plane of the screen', () => {
    const { view, gizmo, node } = setup();
    gizmo.begin(view, { x: 240, y: 160 });
    expect(gizmo.active).toBe('xy');
    gizmo.drag(view, { x: 260, y: 140 });
    const step = view.worldPerPixel([0, 0, 0]);
    close(node.transform.position.asArray(), [20 * step, 20 * step, 0]);
    gizmo.end();
    gizmo.begin(view, { x: 200 + 20 * 1, y: 200 - 20 });
    expect(gizmo.active).toBe('view');
  });

  it('rotates around an axis and around the view', () => {
    const { view, gizmo, node } = setup('rotate');
    // On the ring of z, at its right; dragged a quarter turn to its top.
    gizmo.begin(view, { x: 300, y: 200 });
    expect(gizmo.active).toBe('z');
    gizmo.drag(view, { x: 271, y: 129 });
    gizmo.drag(view, { x: 200, y: 100 });
    const r = node.transform.rotation;
    close([r.x, r.y, r.z, r.w], [0, 0, Math.SQRT1_2, Math.SQRT1_2], 3);
    gizmo.end();

    // The edge on ring of x, dragged along its tangent on screen.
    gizmo.begin(view, { x: 200, y: 150 });
    expect(gizmo.active).toBe('x');
    gizmo.cancel();
    gizmo.snap = { rotate: 90 };
    gizmo.snapping = true;
    gizmo.begin(view, { x: 200, y: 80 });
    expect(gizmo.active).toBe('view');
    gizmo.drag(view, { x: 80, y: 200 });
    const q = node.transform.rotation;
    // A quarter turn more around z (toward the camera), snapped.
    close([q.x, q.y, q.z, q.w], [0, 0, 1, 0], 3);
  });

  it('scales along an axis, uniformly, around the center of the selection', () => {
    const scene = new Scene();
    const a = scene.root.add({ position: { x: -1 } });
    const b = scene.root.add({ position: { x: 1 } });
    const view = viewport();
    const gizmo = new TransformGizmo({ mode: 'scale', size: 100 });
    gizmo.targets = [a, b];
    gizmo.begin(view, { x: 290, y: 200 });
    expect(gizmo.active).toBe('x');
    // Dragged by the length of the axis: twice as large.
    gizmo.drag(view, { x: 390, y: 200 });
    close(a.transform.scale.asArray(), [2, 1, 1]);
    close(a.transform.position.asArray(), [-2, 0, 0]);
    close(b.transform.position.asArray(), [2, 0, 0]);
    gizmo.end();

    gizmo.pivot = 'origin';
    gizmo.begin(view, { x: 400, y: 200 }, { handle: 'uniform' });
    gizmo.drag(view, { x: 450, y: 200 });
    close(b.transform.scale.asArray(), [3, 1.5, 1.5]);
    close(b.transform.position.asArray(), [2, 0, 0]);
  });

  it('moves children in the space of their parent, not twice', () => {
    const scene = new Scene();
    const parent = scene.root.add({ scale: { x: 2, y: 2, z: 2 } });
    const child = parent.add({ position: { x: 0.5 } });
    const view = viewport();
    const gizmo = new TransformGizmo({ size: 100, pivot: 'origin' });
    gizmo.targets = [parent, child];
    // The active one is the child: the gizmo is at its origin, x = 1.
    const center = view.project([1, 0, 0]);
    gizmo.begin(view, { x: center.x + 50, y: center.y });
    gizmo.drag(view, { x: center.x + 50, y: center.y - 40 }, {});
    gizmo.cancel();
    gizmo.begin(view, center);
    expect(gizmo.active).toBe('view');
    const step = view.worldPerPixel([1, 0, 0]);
    gizmo.drag(view, { x: center.x, y: center.y - 40 });
    close(parent.transform.position.asArray(), [0, 40 * step, 0], 3);
    close(child.transform.position.asArray(), [0.5, 0, 0]);

    // A child alone: its world move is halved in its parent.
    gizmo.cancel();
    gizmo.targets = [child];
    gizmo.begin(view, center);
    gizmo.drag(view, { x: center.x, y: center.y - 40 });
    close(child.transform.position.asArray(), [0.5, 20 * step, 0], 3);
  });

  it('moves bare transforms', () => {
    const transform = new Transform({ position: { x: 0 } });
    const view = viewport();
    const gizmo = new TransformGizmo({ size: 100, space: 'local' });
    gizmo.targets = [transform];
    gizmo.begin(view, { x: 250, y: 200 });
    gizmo.drag(view, { x: 300, y: 200 });
    expect(transform.position.x).toBeCloseTo(
      50 * view.worldPerPixel([0, 0, 0]),
    );
  });
});

describe('EditingTools', () => {
  it('drags the gizmo, undoes, deletes', () => {
    const scene = new Scene();
    const node = scene.root.add({ name: 'box' });
    const history = new History();
    const selection = new Selection<typeof node>();
    const gizmo = new TransformGizmo({ size: 100 });
    const tools = new EditingTools({
      viewport: viewport(),
      selection,
      gizmo,
      history,
    });
    selection.set([node]);
    expect(gizmo.targets).toEqual([node]);
    expect(tools.pointerDown({ x: 250, y: 200 })).toBe(true);
    tools.pointerMove({ x: 300, y: 200 });
    tools.pointerUp({ x: 300, y: 200 });
    expect(node.transform.position.x).toBeGreaterThan(0);
    expect(tools.keyDown({ key: 'z', ctrlKey: true })).toBe(true);
    expect(node.transform.position.x).toBe(0);

    // The secondary button is left to the camera.
    expect(tools.pointerDown({ x: 250, y: 200, button: 2 })).toBe(false);
    expect(tools.keyDown({ key: 'e' })).toBe(true);
    expect(gizmo.mode).toBe('rotate');

    expect(tools.keyDown({ key: 'Delete' })).toBe(true);
    expect(selection.size).toBe(0);
    expect(scene.find('box')).toBeUndefined();
    tools.undo();
    expect(scene.find('box')).toBe(node);
  });

  it('gives a finger a larger tolerance, and no hover', () => {
    const scene = new Scene();
    const node = scene.root.add();
    const selection = new Selection<typeof node>();
    const gizmo = new TransformGizmo({ size: 100 });
    const tools = new EditingTools({ viewport: viewport(), selection, gizmo });
    selection.set([node]);
    // 15 pixels below the x axis: too far for a mouse.
    tools.pointerMove({ x: 250, y: 215 });
    expect(gizmo.hovered).toBeUndefined();
    tools.pointerMove({ x: 250, y: 215, pointerType: 'touch' });
    expect(gizmo.hovered).toBeUndefined();
    tools.pointerDown({ x: 250, y: 215, pointerType: 'touch', pointerId: 3 });
    expect(gizmo.active).toBe('x');
    // A second finger is not followed.
    tools.pointerMove({ x: 400, y: 215, pointerType: 'touch', pointerId: 4 });
    expect(node.transform.position.x).toBe(0);
    tools.pointerUp({ x: 250, y: 215, pointerType: 'touch', pointerId: 3 });
    expect(gizmo.dragging).toBe(false);
  });

  it('follows a rectangle', () => {
    const tools = new EditingTools({
      viewport: viewport(),
      selection: new Selection<Transform>(),
    });
    tools.pointerDown({ x: 10, y: 10 });
    tools.pointerMove({ x: 12, y: 11 });
    expect(tools.rectangle).toBeUndefined();
    tools.pointerMove({ x: 60, y: 40 });
    expect(tools.rectangle).toEqual({
      from: { x: 10, y: 10 },
      to: { x: 60, y: 40 },
    });
    tools.keyDown({ key: 'Escape' });
    expect(tools.rectangle).toBeUndefined();
  });
});
