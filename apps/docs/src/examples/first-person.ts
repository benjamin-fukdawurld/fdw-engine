import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { FlyActions, FlyOperator, forwardOf } from '@fdw/engine-camera';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { createCube, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// First person controls: the pointer locked to look around, the shots
// felt in the gamepad, a pause menu over the game. Two contexts of
// actions, one enabled at a time: the menu, then the game.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The keys and the right button drive the example, not the page.
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());

  // The scene: a ground, pillars to shoot, a sun.
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
  // Each pillar: its material, and its box to hit.
  const pillars: { material: Material; min: number[]; max: number[] }[] = [];
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const height = 1 + 2 * (0.5 + 0.5 * Math.sin(i * 1.7 + j * 2.3));
      const [x, z] = [i * 3, j * 3];
      const material = new Material({
        graph,
        values: { baseColor: [0.35, 0.45, 0.6] },
      });
      items.push({
        mesh: cube,
        material,
        transform: new Transform({
          position: { x, y: height / 2, z },
          scale: { x: 0.8, y: height, z: 0.8 },
        }),
      });
      pillars.push({
        material,
        min: [x - 0.4, 0, z - 0.4],
        max: [x + 0.4, height, z + 0.4],
      });
    }
  }
  // The crosshair: a dot just in front of the camera.
  const c = new GraphBuilder('crosshair');
  c.surface({ baseColor: [1, 1, 1] });
  const crosshair = new Transform({ scale: { x: 0.004, y: 0.004, z: 0.004 } });
  items.push({
    mesh: cube,
    material: new Material({ graph: c.build() }),
    transform: crosshair,
  });
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
      fov: 60,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const input = new Input(new WebInputSource(canvas));

  // The game: walking, looking with the pointer locked (FlyActions binds
  // `pointer:locked` to `drag`), shooting, pausing.
  const game = new ActionMap(
    input,
    {
      ...FlyActions,
      fire: {
        type: 'button',
        bindings: ['pointer:0', 'key:Space', 'gamepad:rightTrigger'],
      },
      pause: { type: 'button', bindings: ['key:Escape', 'gamepad:start'] },
      locked: { type: 'button', bindings: ['pointer:locked'] },
    },
    { enabled: false }
  );
  const fly = new FlyOperator(camera, game, {
    mode: 'walk',
    position: { x: 0, y: 1.6, z: 13 },
    pointerSpeed: 2,
  });

  // The menu: its own actions, enabled while it is open.
  const menu = new ActionMap(input, {
    up: {
      type: 'button',
      bindings: ['key:ArrowUp', 'key:KeyW', 'gamepad:dpadUp'],
    },
    down: {
      type: 'button',
      bindings: ['key:ArrowDown', 'key:KeyS', 'gamepad:dpadDown'],
    },
    confirm: {
      type: 'button',
      bindings: ['key:Enter', 'key:Space', 'pointer:0', 'gamepad:south'],
    },
  });
  let rumble = true;
  const entries = [
    () => 'Play',
    () => `Rumble: ${rumble ? 'on' : 'off'}`,
    () => `Invert Y: ${fly.invertY ? 'on' : 'off'}`,
  ];
  let selected = 0;
  let hits = 0;

  const show = () =>
    info(
      menu.enabled
        ? `paused · ${entries
            .map((entry, i) => (i === selected ? `[${entry()}]` : entry()))
            .join(' · ')}`
        : `playing · hits: ${hits} · ${
            input.pointer.locked ? 'Esc: menu' : 'click to look around'
          }`
    );
  show();

  const play = () => {
    menu.enabled = false;
    game.enabled = true;
    // After a click or a key: the browser accepts the lock.
    input.lockPointer();
    show();
  };
  const pause = () => {
    game.enabled = false;
    menu.enabled = true;
    input.lockPointer(false);
    show();
  };

  // A shot: the first pillar on the ray of the camera turns orange.
  const fire = () => {
    const origin = [fly.position.x, fly.position.y, fly.position.z];
    const f = forwardOf(fly.yaw, fly.pitch, { x: 0, y: 0, z: 0 });
    const direction = [f.x, f.y, f.z];
    let best: (typeof pillars)[number] | undefined;
    let nearest = Infinity;
    for (const pillar of pillars) {
      const t = hitBox(origin, direction, pillar.min, pillar.max);
      if (t < nearest) {
        nearest = t;
        best = pillar;
      }
    }
    if (best) {
      best.material.setValue('baseColor', [1, 0.45, 0.1]);
      hits++;
    }
    if (rumble) {
      // A hit shakes more, and longer.
      game.rumble(best ? 0.8 : 0.2, best ? 0.4 : 0.6, best ? 0.25 : 0.08);
    }
    show();
  };

  let previous: number | undefined;
  onFrame((time) => {
    const dt = Math.min(0.1, time - (previous ?? time));
    previous = time;
    input.update();

    if (menu.active) {
      const count = entries.length;
      if (menu.button('up').pressed) {
        selected = (selected + count - 1) % count;
      }
      if (menu.button('down').pressed) {
        selected = (selected + 1) % count;
      }
      if (menu.button('confirm').pressed) {
        if (selected === 0) {
          play();
        } else if (selected === 1) {
          rumble = !rumble;
          if (rumble) {
            menu.rumble(0.5, 0.5, 0.15);
          }
        } else {
          fly.invertY = !fly.invertY;
        }
      }
      if (menu.enabled) {
        show();
      }
    } else if (game.active) {
      // Escape releases the lock in a browser: the game pauses then.
      if (game.button('pause').pressed || game.button('locked').released) {
        pause();
      } else if (game.button('fire').pressed) {
        if (!input.pointer.locked && input.pointer.pressed(0)) {
          // Unlocked, a click locks the pointer first.
          input.lockPointer();
        } else {
          fire();
        }
      }
      if (game.button('locked').pressed) {
        show();
      }
    }

    // Disabled with the game, the operator reads nothing under the menu.
    fly.enabled = game.enabled;
    followAspect(camera, surface);
    fly.update(dt);
    const f = forwardOf(fly.yaw, fly.pitch, { x: 0, y: 0, z: 0 });
    crosshair.position = {
      x: fly.position.x + f.x * 0.5,
      y: fly.position.y + f.y * 0.5,
      z: fly.position.z + f.z * 0.5,
    };
    renderer.render({
      items,
      camera,
      surface,
      time,
      // The game is dimmed under the menu.
      exposure: menu.enabled ? 0.35 : 1,
      lights: [sun],
      clearColor: { r: 0.45, g: 0.6, b: 0.8, a: 1 },
    });
  });
};

// The distance along the ray to an axis-aligned box, Infinity if missed
// (the slab method).
function hitBox(
  origin: number[],
  direction: number[],
  min: number[],
  max: number[]
): number {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const inverse = 1 / direction[axis];
    let t0 = (min[axis] - origin[axis]) * inverse;
    let t1 = (max[axis] - origin[axis]) * inverse;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
    }
    near = Math.max(near, t0);
    far = Math.min(far, t1);
  }
  return near <= far ? near : Infinity;
}

export default example;
