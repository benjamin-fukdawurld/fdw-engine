import { describe, expect, it } from 'vitest';
import { ActionMap, FakeInputSource, Input } from '@fdw/engine-input';
import { FlyActions, FlyOperator } from './FlyOperator';
import { OrbitActions, OrbitOperator } from './OrbitOperator';
import { forwardOf, rotationOf, Vec3Like } from './target';

// A camera as the operators see it: a position, a rotation, a projection.
const camera = () => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  projection: { type: 'perspective', fov: 90, aspect: 2 },
});

const setup = () => {
  const source = new FakeInputSource();
  const input = new Input(source);
  return { source, input, pad: source.connectGamepad() };
};

// Rotates v by the quaternion q.
function rotate(
  q: { x: number; y: number; z: number; w: number },
  v: Vec3Like
): Vec3Like {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

const expectClose = (a: Vec3Like, b: Vec3Like) => {
  expect(a.x).toBeCloseTo(b.x);
  expect(a.y).toBeCloseTo(b.y);
  expect(a.z).toBeCloseTo(b.z);
};

describe('rotationOf', () => {
  it('turns -z to where the yaw and the pitch look', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [Math.PI / 2, 0],
      [0.7, -0.4],
      [-2, 1.2],
    ]) {
      expectClose(
        rotate(rotationOf(yaw, pitch), { x: 0, y: 0, z: -1 }),
        forwardOf(yaw, pitch, { x: 0, y: 0, z: 0 })
      );
    }
    // Yaw positive: to the left.
    expectClose(forwardOf(Math.PI / 2, 0, { x: 0, y: 0, z: 0 }), {
      x: -1,
      y: 0,
      z: 0,
    });
  });
});

describe('FlyOperator', () => {
  it('moves with the left stick, looks with the right one', () => {
    const { source, input, pad } = setup();
    const target = camera();
    const fly = new FlyOperator(target, new ActionMap(input, FlyActions), {
      speed: 2,
    });
    // Pushed up: forward, along -z.
    source.setAxis(pad, 'leftY', -1);
    input.update();
    fly.update(0.5);
    expectClose(target.position, { x: 0, y: 0, z: -1 });
    // The right stick to the right: turns right.
    source.setAxis(pad, 'leftY', 0);
    source.setAxis(pad, 'rightX', 1);
    input.update();
    fly.update(0.1);
    expect(fly.yaw).toBeCloseTo(-0.25);
    expectClose(target.rotation, rotationOf(-0.25, 0));
  });

  it('moves with the keys, faster when running, up and down', () => {
    const { source, input } = setup();
    const target = camera();
    const fly = new FlyOperator(target, new ActionMap(input, FlyActions));
    source.keyDown('KeyD');
    source.keyDown('KeyE');
    source.keyDown('ShiftLeft');
    input.update();
    fly.update(0.1);
    // 5 × 3 per second, for 0.1 s: to the right, and up.
    expectClose(target.position, { x: 1.5, y: 1.5, z: 0 });
  });

  it('looks with the pointer while dragged, the width scaled by the aspect', () => {
    const { source, input } = setup();
    const fly = new FlyOperator(camera(), new ActionMap(input, FlyActions), {
      pointerSpeed: 1,
    });
    source.sink?.pointerMove(0.5, 0.5);
    input.update();
    // Moved without a button: nothing.
    source.sink?.pointerMove(0.6, 0.5);
    input.update();
    fly.update(0.016);
    expect(fly.yaw).toBe(0);
    source.sink?.pointerButton(0, true);
    input.update();
    source.sink?.pointerMove(0.7, 0.4);
    input.update();
    fly.update(0.016);
    // 0.1 of the width: 0.2 heights (aspect 2); 0.1 up.
    expect(fly.yaw).toBeCloseTo(-0.2);
    expect(fly.pitch).toBeCloseTo(0.1);
  });

  it('stays horizontal when walking, and stops at the vertical', () => {
    const { source, input, pad } = setup();
    const target = camera();
    const fly = new FlyOperator(target, new ActionMap(input, FlyActions), {
      mode: 'walk',
      pitch: 1,
    });
    source.setAxis(pad, 'leftY', -1);
    source.setAxis(pad, 'rightY', -1);
    input.update();
    fly.update(1);
    expect(target.position.y).toBeCloseTo(0);
    expect(target.position.z).toBeLessThan(0);
    expect(fly.pitch).toBeCloseTo((89 * Math.PI) / 180);
  });

  it('reads rebound controls and actions of other names', () => {
    const { source, input } = setup();
    const actions = new ActionMap(input, {
      ...FlyActions,
      walk: FlyActions.move,
    });
    actions.rebind('walk', [
      { up: 'key:KeyI', down: 'key:KeyK', left: 'key:KeyJ', right: 'key:KeyL' },
    ]);
    const target = camera();
    const fly = new FlyOperator(target, actions, { names: { move: 'walk' } });
    source.keyDown('KeyW');
    input.update();
    fly.update(1);
    expectClose(target.position, { x: 0, y: 0, z: 0 });
    source.keyDown('KeyI');
    input.update();
    fly.update(1);
    expectClose(target.position, { x: 0, y: 0, z: -5 });
  });

  it('looks at a point, and does nothing when disabled', () => {
    const { source, input } = setup();
    const target = camera();
    const fly = new FlyOperator(target, new ActionMap(input, FlyActions), {
      position: { x: 0, y: 1, z: 5 },
    });
    fly.lookAt({ x: 5, y: 1, z: 5 });
    expect(fly.yaw).toBeCloseTo(-Math.PI / 2);
    expectClose(rotate(target.rotation, { x: 0, y: 0, z: -1 }), {
      x: 1,
      y: 0,
      z: 0,
    });
    fly.enabled = false;
    source.keyDown('KeyW');
    input.update();
    fly.update(1);
    expectClose(target.position, { x: 0, y: 1, z: 5 });
  });
});

describe('OrbitOperator', () => {
  it('looks at its pivot from its distance', () => {
    const { input } = setup();
    const target = camera();
    new OrbitOperator(target, new ActionMap(input, OrbitActions), {
      pivot: { x: 1, y: 2, z: 3 },
      distance: 4,
      yaw: 0,
      pitch: 0,
    });
    expectClose(target.position, { x: 1, y: 2, z: 7 });
    expectClose(target.rotation, rotationOf(0, 0));
  });

  it('turns with the right stick, moves the pivot with the left one', () => {
    const { source, input, pad } = setup();
    const target = camera();
    const orbit = new OrbitOperator(
      target,
      new ActionMap(input, OrbitActions),
      { distance: 2, pitch: 0 }
    );
    source.setAxis(pad, 'rightX', 1);
    input.update();
    orbit.update(0.5);
    expect(orbit.yaw).toBeCloseTo(-1);
    // Still at its distance from the pivot, looking at it.
    expect(Math.hypot(target.position.x, target.position.z)).toBeCloseTo(2);
    expectClose(rotate(target.rotation, { x: 0, y: 0, z: -2 }), {
      x: -target.position.x,
      y: -target.position.y,
      z: -target.position.z,
    });
    // Forward, over the ground: where the camera looks, horizontally.
    source.setAxis(pad, 'rightX', 0);
    source.setAxis(pad, 'leftY', -1);
    input.update();
    orbit.update(0.25);
    const ahead = forwardOf(orbit.yaw, 0, { x: 0, y: 0, z: 0 });
    expectClose(orbit.pivot, { x: ahead.x * 0.5, y: 0, z: ahead.z * 0.5 });
  });

  it('zooms with the wheel and the triggers, within its limits', () => {
    const { source, input, pad } = setup();
    const orbit = new OrbitOperator(
      camera(),
      new ActionMap(input, OrbitActions),
      { distance: 10, maxDistance: 12 }
    );
    source.sink?.wheel(-2);
    input.update();
    orbit.update(0.016);
    expect(orbit.distance).toBeCloseTo(10 * Math.exp(-0.2));
    source.setButton(pad, 'leftTrigger', 1);
    input.update();
    orbit.update(10);
    expect(orbit.distance).toBe(12);
  });

  it('pans with the pointer dragged: the pivot follows it', () => {
    const { source, input } = setup();
    const orbit = new OrbitOperator(
      camera(),
      new ActionMap(input, OrbitActions),
      { distance: 1, yaw: 0, pitch: 0 }
    );
    source.sink?.pointerMove(0.5, 0.5);
    source.sink?.pointerButton(2, true);
    input.update();
    source.sink?.pointerMove(0.75, 0.25);
    input.update();
    orbit.update(0.016);
    // fov 90°: the view is 2 high at a distance of 1, 4 wide; the pointer
    // went a quarter of each to the right and up: the scene follows it.
    expectClose(orbit.pivot, { x: -1, y: -0.5, z: 0 });
  });
});
