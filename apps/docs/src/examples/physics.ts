import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import {
  PhysicsDebugView,
  ScenePhysics,
  Shapes,
  type Shape,
} from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { Scene, Scheduler } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCapsule,
  createCube,
  createSphere,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Bodies falling on a pyramid of boxes, on Rapier: the bodies are
// components of the scene, the simulation a system of the fixed step. A
// click pushes what is under the pointer, Space throws a ball there, D
// shows the debug view, R starts again.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  canvas.addEventListener('pointerdown', () => canvas.focus());
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
    }
  });

  // The engine (its WebAssembly, loaded once), a world, its scene.
  const engine = await createRapierPhysics();
  const world = engine.createWorld({ gravity: { x: 0, y: -9.81, z: 0 } });
  const scene = new Scene();
  const physics = new ScenePhysics(scene, world);
  const debug = new PhysicsDebugView(scene, world);
  debug.enabled = false;

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
  const capsule = createCapsule(0.25, 0.2);
  const colors = [
    material([0.9, 0.3, 0.2]),
    material([0.95, 0.75, 0.2]),
    material([0.25, 0.7, 0.35]),
    material([0.25, 0.5, 0.9]),
  ];

  // A node, its mesh at the size of its shape, and its body.
  const add = (
    type: 'static' | 'dynamic',
    shape: Shape,
    position: { x?: number; y?: number; z?: number },
    color: Material,
  ) => {
    const node = scene.root.add({ position });
    if (shape.type === 'box') {
      const { x, y, z } = shape.halfExtents;
      node.transform.scale = { x: 2 * x, y: 2 * y, z: 2 * z };
      node.setMesh(cube, color);
    } else if (shape.type === 'sphere') {
      const d = 2 * shape.radius;
      node.transform.scale = { x: d, y: d, z: d };
      node.setMesh(sphere, color);
    } else {
      node.setMesh(capsule, color);
    }
    physics.add(node, { type, colliders: [{ shape }] });
    return node;
  };

  // The ground: a static body.
  add(
    'static',
    Shapes.box(8, 0.5, 8),
    { y: -0.5 },
    material([0.32, 0.34, 0.38]),
  );

  // A pyramid of boxes under a rain of shapes; R builds them again.
  let bodies: ReturnType<typeof add>[] = [];
  let dropped = 0;
  const drop = (y: number) => {
    const shapes = [
      Shapes.sphere(0.3),
      Shapes.capsule(0.25, 0.2),
      Shapes.box(0.3),
    ];
    const x = ((dropped * 7) % 9) * 0.75 - 3;
    const z = ((dropped * 5) % 7) / 3 - 1.5;
    bodies.push(
      add('dynamic', shapes[dropped % 3], { x, y, z }, colors[dropped % 4]),
    );
    dropped++;
  };
  const build = () => {
    bodies.forEach((node) => node.alive && node.remove());
    bodies = [];
    dropped = 0;
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i < 5 - row; i++) {
        const x = (i - (4 - row) / 2) * 1.02;
        bodies.push(
          add(
            'dynamic',
            Shapes.box(0.5),
            { x, y: 0.5 + row, z: -1 },
            colors[row % 4],
          ),
        );
      }
    }
    // The first drops, already falling.
    for (let i = 0; i < 8; i++) {
      drop(5.5 + i * 0.25);
    }
  };
  build();

  scene.root.add({ rotation: axisAngle(1, 0.3, 0, -1.1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      diffuse: { x: 1.2, y: 1.15, z: 1.1 },
      ambient: { x: 0.15, y: 0.16, z: 0.2 },
    }),
  );
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const pitch = -0.35;
  const eye = { x: 0, y: 6, z: 14 };
  scene.root
    .add({ position: eye, rotation: axisAngle(1, 0, 0, pitch) })
    .setCamera(camera);
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // The ray under the pointer: from the eye, through the pointer on the
  // near plane (the camera turned by `pitch` around x).
  const pointerRay = (px: number, py: number) => {
    const t = Math.tan((50 * Math.PI) / 360);
    const x = (px * 2 - 1) * t * (canvas.width / canvas.height);
    const y = (1 - py * 2) * t;
    const [c, s] = [Math.cos(pitch), Math.sin(pitch)];
    // (x, y, -1) turned around x.
    const d = { x, y: y * c + s, z: y * s - c };
    const length = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / length, y: d.y / length, z: d.z / length };
  };

  const input = new Input(new WebInputSource(canvas));
  const button = (...bindings: string[]) => ({
    type: 'button' as const,
    bindings,
  });
  const actions = new ActionMap(input, {
    push: button('pointer:0'),
    throw: button('key:Space'),
    debug: button('key:KeyD'),
    reset: button('key:KeyR'),
  });

  const scheduler = new Scheduler({ step: 1 / 60 });
  // begin: the input; a push or a throw where the pointer is.
  scheduler.add(
    'input',
    () => {
      input.update();
      // From 0 to 1 over the canvas.
      const direction = pointerRay(input.pointer.x, input.pointer.y);
      if (actions.button('push').pressed) {
        const hit = world.raycast(eye, direction, 50);
        debug.ray(eye, direction, 50, hit);
        if (hit?.body.type === 'dynamic') {
          const strength = 5 * hit.body.mass;
          hit.body.applyImpulse(
            {
              x: direction.x * strength,
              y: direction.y * strength,
              z: direction.z * strength,
            },
            hit.point,
          );
        }
      }
      if (actions.button('throw').pressed) {
        const ball = add('dynamic', Shapes.sphere(0.3), eye, colors[3]);
        const body = physics.bodyOf(ball);
        if (body) {
          body.linearVelocity = {
            x: direction.x * 25,
            y: direction.y * 25,
            z: direction.z * 25,
          };
        }
        bodies.push(ball);
      }
      if (actions.button('debug').pressed) {
        debug.enabled = !debug.enabled;
      }
      if (actions.button('reset').pressed) {
        build();
      }
    },
    { phase: 'begin' },
  );
  // fixed: a shape every half second (24 at most), then the simulation.
  let time = 0;
  scheduler.add(
    'rain',
    (step) => {
      time += step;
      if (time > 0.5 && dropped < 24) {
        time = 0;
        drop(9);
      }
    },
    { phase: 'fixed', before: ['physics'] },
  );
  // physics in the fixed phase, physics:sync (the nodes) in update.
  physics.install(scheduler);
  scheduler.add('debug', (dt) => debug.update(dt), { after: ['physics:sync'] });
  scheduler.add(
    'render',
    () => {
      renderer.render({
        source: scene,
        camera,
        surface,
        clearColor: { r: 0.08, g: 0.09, b: 0.11, a: 1 },
      });
      let asleep = 0;
      for (const body of world.bodies) {
        asleep += body.type === 'dynamic' && body.sleeping ? 1 : 0;
      }
      info(
        `${bodies.length} bodies, ${asleep} asleep · debug ${
          debug.enabled ? 'on' : 'off'
        } · click: push, Space: throw, D: debug, R: reset`,
      );
    },
    { phase: 'render' },
  );

  let last = 0;
  onFrame((now) => {
    scheduler.update(Math.min(now - last, 0.1));
    last = now;
  });
};

export default example;
