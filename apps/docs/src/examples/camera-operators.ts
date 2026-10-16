import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import {
  FlyActions,
  FlyOperator,
  OrbitActions,
  OrbitOperator,
} from '@fdw/engine-camera';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { createCube, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Two camera operators over a field of pillars: orbit around the center,
// or fly through it. Click the canvas, then the mouse, the keyboard or a
// gamepad; C or the north button (Y on Xbox) switches the operator.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The keys, the wheel and the right button drive the camera, not the
  // page.
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('wheel', (event) => event.preventDefault(), {
    passive: false,
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  // The drag goes on outside of the canvas.
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
  });

  // The scene: a ground, pillars of every height and color, a sun.
  const g = new GraphBuilder('pillar');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    metallic: 0,
    roughness: 0.6,
  });
  const graph = g.build();
  const cube = createCube();
  const items: RenderItem[] = [
    {
      mesh: cube,
      material: new Material({ graph, values: { baseColor: [0.5, 0.5, 0.5] } }),
      transform: new Transform({
        position: { x: 0, y: -0.05, z: 0 },
        scale: { x: 24, y: 0.1, z: 24 },
      }),
    },
  ];
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const height = 0.5 + 2.5 * (0.5 + 0.5 * Math.sin(i * 1.7 + j * 2.3));
      items.push({
        mesh: cube,
        material: new Material({
          graph,
          values: {
            baseColor: [0.5 + 0.06 * i, 0.45, 0.5 + 0.06 * j],
          },
        }),
        transform: new Transform({
          position: { x: i * 2.5, y: height / 2, z: j * 2.5 },
          scale: { x: 0.8, y: height, z: 0.8 },
        }),
      });
    }
  }
  const sun = new DirectionalLight({
    direction: { x: -0.5, y: -1, z: -0.3 },
    ambient: { x: 0.08, y: 0.09, z: 0.1 },
    diffuse: { x: 1.2, y: 1.15, z: 1.1 },
    specular: { x: 0.5, y: 0.5, z: 0.5 },
    castShadow: true,
  });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // The input, and the actions of each operator, with their default
  // bindings.
  const input = new Input(new WebInputSource(canvas));
  const orbit = new OrbitOperator(camera, new ActionMap(input, OrbitActions), {
    distance: 22,
    yaw: 0.6,
    pitch: -0.55,
    minPitch: -1.5,
    maxPitch: -0.05,
  });
  const fly = new FlyOperator(camera, new ActionMap(input, FlyActions), {
    mode: 'walk',
    position: { x: 0, y: 1.7, z: 14 },
  });
  fly.enabled = false;
  const switching = new ActionMap(input, {
    switch: { type: 'button', bindings: ['key:KeyC', 'gamepad:north'] },
  });

  const show = () =>
    info(
      orbit.enabled
        ? 'orbit · drag, right drag, wheel, WASD, arrows, sticks · C: walk'
        : 'walk · WASD, drag, arrows, Q/E, sticks, triggers · C: orbit',
    );
  show();

  let previous: number | undefined;
  onFrame((time) => {
    // The step of the frame, at most a tenth of a second (a tab hidden).
    const dt = Math.min(0.1, time - (previous ?? time));
    previous = time;
    input.update();
    if (switching.button('switch').pressed) {
      orbit.enabled = !orbit.enabled;
      fly.enabled = !orbit.enabled;
      // Each operator goes back to where it left the camera.
      (orbit.enabled ? orbit : fly).apply();
      show();
    }
    followAspect(camera, surface);
    orbit.update(dt);
    fly.update(dt);
    renderer.render({
      items,
      camera,
      surface,
      time,
      lights: [sun],
      clearColor: { r: 0.45, g: 0.6, b: 0.8, a: 1 },
    });
  });
};

export default example;
