import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  TransformLayout,
} from '@fdw/engine-core';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Balls bouncing in an arena, run by a scheduler: the input at the start
// of the frame, the physics at a fixed step, the balls drawn between two
// steps, then the rendering. Keys to pause, step, slow down, lower the
// rate of the steps and turn the interpolation off.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.5,
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const sphere = createSphere(24, 12);

  const scene = new Scene();
  // The arena: a floor and four low walls, static.
  const half = 6;
  scene.root
    .add({
      position: { y: -0.25 },
      scale: { x: 2 * half, y: 0.5, z: 2 * half },
      static: true,
    })
    .setMesh(cube, material([0.45, 0.47, 0.5]));
  const wall = material([0.3, 0.32, 0.36]);
  for (const [x, z, sx, sz] of [
    [0, -half - 0.25, 2 * half + 1, 0.5],
    [0, half + 0.25, 2 * half + 1, 0.5],
    [-half - 0.25, 0, 0.5, 2 * half],
    [half + 0.25, 0, 0.5, 2 * half],
  ]) {
    scene.root
      .add({
        position: { x, y: 0.4, z },
        scale: { x: sx, y: 0.8, z: sz },
        static: true,
      })
      .setMesh(cube, wall);
  }
  scene.root.add({ rotation: axisAngle(1, 0.3, 0, -1.1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      diffuse: { x: 1.2, y: 1.15, z: 1.1 },
      ambient: { x: 0.15, y: 0.16, z: 0.2 },
    }),
  );

  // A ball: its position at the last step and at the one before, its
  // velocity. A component of the world of the scene.
  const Ball = scene.world.defineComponent('ball', {
    x: 'f32',
    y: 'f32',
    z: 'f32',
    px: 'f32',
    py: 'f32',
    pz: 'f32',
    vx: 'f32',
    vy: 'f32',
    vz: 'f32',
  });
  const radius = 0.35;
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const colors: [number, number, number][] = [
    [0.9, 0.3, 0.2],
    [0.95, 0.75, 0.2],
    [0.25, 0.7, 0.35],
    [0.25, 0.5, 0.9],
  ];
  for (let i = 0; i < 40; i++) {
    const { entity } = scene.root
      .add({ scale: { x: 2 * radius, y: 2 * radius, z: 2 * radius } })
      .setMesh(sphere, material(colors[i % colors.length]));
    const x = random() * 10 - 5;
    const y = 1 + random() * 4;
    const z = random() * 10 - 5;
    scene.world.add(entity, Ball, {
      x,
      y,
      z,
      px: x,
      py: y,
      pz: z,
      vx: random() * 6 - 3,
      vz: random() * 6 - 3,
    });
  }
  const balls = scene.world.query(Ball);

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  scene.root
    .add({ position: { y: 11, z: 13 }, rotation: axisAngle(1, 0, 0, -0.7) })
    .setCamera(camera);
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const input = new Input(new WebInputSource(canvas));
  const button = (code: string) => ({
    type: 'button' as const,
    bindings: [`key:${code}`],
  });
  const actions = new ActionMap(input, {
    pause: button('KeyP'),
    step: button('KeyN'),
    slow: button('KeyS'),
    rate: button('KeyL'),
    interpolate: button('KeyI'),
  });
  let interpolate = true;

  const scheduler = new Scheduler({ step: 1 / 60 });

  // begin: the input of the frame, and what it switches.
  scheduler.add(
    'input',
    () => {
      input.update();
      if (actions.button('pause').pressed) {
        scheduler.paused = !scheduler.paused;
      }
      if (actions.button('step').pressed && scheduler.paused) {
        scheduler.step();
      }
      if (actions.button('slow').pressed) {
        scheduler.timeScale = scheduler.timeScale === 1 ? 0.25 : 1;
      }
      if (actions.button('rate').pressed) {
        scheduler.fixed.step =
          scheduler.fixed.step === 1 / 60 ? 1 / 10 : 1 / 60;
      }
      if (actions.button('interpolate').pressed) {
        interpolate = !interpolate;
      }
    },
    { phase: 'begin' },
  );

  // fixed: the physics, at each step. Added out of order: the constraints
  // order them.
  scheduler.add(
    'move',
    (step) => {
      for (const e of balls.entities) {
        Ball.px[e] = Ball.x[e];
        Ball.py[e] = Ball.y[e];
        Ball.pz[e] = Ball.z[e];
        Ball.x[e] += Ball.vx[e] * step;
        Ball.y[e] += Ball.vy[e] * step;
        Ball.z[e] += Ball.vz[e] * step;
      }
    },
    { phase: 'fixed' },
  );
  scheduler.add(
    'bounce',
    () => {
      const wall = half - radius;
      for (const e of balls.entities) {
        if (Ball.y[e] < radius) {
          Ball.y[e] = radius;
          Ball.vy[e] = Math.abs(Ball.vy[e]) * 0.9;
        }
        if (Math.abs(Ball.x[e]) > wall) {
          Ball.x[e] = Math.sign(Ball.x[e]) * wall;
          Ball.vx[e] = -Ball.vx[e];
        }
        if (Math.abs(Ball.z[e]) > wall) {
          Ball.z[e] = Math.sign(Ball.z[e]) * wall;
          Ball.vz[e] = -Ball.vz[e];
        }
      }
    },
    { phase: 'fixed', after: ['move'] },
  );
  scheduler.add(
    'gravity',
    (step) => {
      for (const e of balls.entities) {
        Ball.vy[e] -= 9.81 * step;
      }
    },
    { phase: 'fixed', before: ['move'] },
  );
  // A ball resting on the floor jumps again.
  scheduler.add(
    'kick',
    () => {
      for (const e of balls.entities) {
        if (Ball.y[e] <= radius && Math.abs(Ball.vy[e]) < 2) {
          Ball.vy[e] = 6 + random() * 4;
        }
      }
    },
    { phase: 'fixed', after: ['bounce'] },
  );

  // update: the nodes between the last two steps, once per frame.
  scheduler.add('interpolate', () => {
    const a = interpolate ? scheduler.alpha : 1;
    const { data } = scene.transforms;
    const { stride, position } = TransformLayout;
    for (const e of balls.entities) {
      const o = e * stride + position;
      data[o] = Ball.px[e] + (Ball.x[e] - Ball.px[e]) * a;
      data[o + 1] = Ball.py[e] + (Ball.y[e] - Ball.py[e]) * a;
      data[o + 2] = Ball.pz[e] + (Ball.z[e] - Ball.pz[e]) * a;
      scene.transforms.touch(e);
    }
  });

  // render: the rendering, and the state under the canvas.
  scheduler.add(
    'render',
    () => {
      renderer.render({
        source: scene,
        camera,
        surface,
        clearColor: { r: 0.08, g: 0.09, b: 0.11, a: 1 },
      });
    },
    { phase: 'render' },
  );
  scheduler.add(
    'status',
    () => {
      const rate = Math.round(1 / scheduler.fixed.step);
      info(
        [
          scheduler.paused ? 'paused' : `×${scheduler.timeScale}`,
          `${rate} steps/s`,
          `interpolation ${interpolate ? 'on' : 'off'}`,
          `${scheduler.time.toFixed(2)} s simulated`,
          'click, then P, N, S, L, I',
        ].join(' · '),
      );
    },
    { phase: 'render', after: ['render'] },
  );

  let last = 0;
  onFrame((time) => {
    scheduler.update(time - last);
    last = time;
  });
};

export default example;
