import { AnimationGraphBuilder, Animator } from '@fdw/engine-animation';
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { ThirdPersonActions, ThirdPersonOperator } from '@fdw/engine-camera';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { installGltf } from '@fdw/engine-gltf';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { ScenePhysics, Shapes } from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { clipsOf, Skinning } from '@fdw/engine-skinning';
import { axisAngle, createCube, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A ranger walking among pillars, seen over the shoulder: the camera turns
// around it with the pointer, follows it smoothly, and comes closer when a
// pillar stands between them. The ranger is a character controller of the
// physics, moved relative to the view.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space')
      event.preventDefault();
  });
  const resources = new ResourceStore();
  resources.mount('http', new HttpSource({ base: '/fdw-engine/models/' }), {
    default: true,
  });
  installAssets(resources, {
    backend,
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);
  const handle = resources.load<Model>(ModelType, 'forest/hero.glb');
  const [engine] = await Promise.all([createRapierPhysics(), handle.ready]);
  const model = handle.require();

  // The level: a ground and pillars, with their bodies.
  const scene = new Scene();
  const world = engine.createWorld();
  const physics = new ScenePhysics(scene, world);
  const g = new GraphBuilder('stone');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.9,
  });
  const stone = (color: number[]) =>
    new Material({ graph: g.build(), values: { color } });
  const cube = createCube();
  const ground = scene.root.add({
    position: { y: -0.5 },
    scale: { x: 60, y: 1, z: 60 },
  });
  ground.setMesh(cube, stone([0.36, 0.34, 0.3]));
  physics.add(ground, {
    type: 'static',
    colliders: [{ shape: Shapes.box(30, 0.5, 30) }],
  });
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    const radius = 6 + (i % 3) * 4;
    const pillar = scene.root.add({
      position: {
        x: Math.cos(angle) * radius,
        y: 2,
        z: Math.sin(angle) * radius,
      },
      scale: { x: 0.8, y: 4, z: 0.8 },
    });
    pillar.setMesh(cube, stone([0.55, 0.5, 0.45]));
    physics.add(pillar, {
      type: 'static',
      colliders: [{ shape: Shapes.box(0.4, 2, 0.4) }],
    });
  }
  scene.root.add({ rotation: axisAngle(0.5, 1, 0.3, -0.8) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.3, y: 0.32, z: 0.36 },
      diffuse: { x: 2.2, y: 2.1, z: 1.9 },
    }),
  );

  // The ranger: a capsule moved by the character controller, the model
  // under it, turned where it walks.
  const body = scene.root.add({ position: { y: 0.92 } });
  const character = physics.addCharacter(body, {
    shape: Shapes.capsule(0.6, 0.32),
  });
  const visual = body.add({ position: { y: -0.92 } });
  const ranger = instantiate(handle, scene, { parent: visual });
  const skinning = new Skinning(backend, ranger, model);
  const a = new AnimationGraphBuilder('ranger');
  a.parameter('speed', 'number');
  a.output(
    a.blend1d(
      [a.clip('SwordIdle'), a.clip('Walk'), a.clip('Jog')],
      [0, 1.6, 4.5],
      a.param('speed'),
    ),
  );
  const animator = new Animator(a.build(), {
    skeleton: skinning.skeleton,
    clips: clipsOf(model, skinning.skeleton),
  });

  // The camera: the pointer locked (or the right stick) turns it; it stops
  // short of what a sphere cast from the head hits, the ranger aside.
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });
  const input = new Input(new WebInputSource(canvas));
  const actions = new ActionMap(input, {
    ...ThirdPersonActions,
    move: {
      type: 'vector',
      bindings: [
        {
          up: 'key:KeyW',
          down: 'key:KeyS',
          left: 'key:KeyA',
          right: 'key:KeyD',
        },
        'gamepad:leftStick',
      ],
    },
  });
  const operator = new ThirdPersonOperator(camera, actions, {
    yaw: Math.PI,
    probe: (from, to, radius) => {
      const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
      const length = Math.hypot(d.x, d.y, d.z);
      return world.shapeCast(
        Shapes.sphere(radius),
        from,
        { x: 0, y: 0, z: 0, w: 1 },
        { x: d.x / length, y: d.y / length, z: d.z / length },
        length,
        { exclude: character.body },
      )?.distance;
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  let previous: number | undefined;
  let yaw = 0;
  let speed = 0;
  let fall = 0;
  onFrame((time) => {
    const dt = Math.min(0.05, time - (previous ?? time));
    previous = time;
    input.update();
    if (!input.pointer.locked && input.pointer.pressed(0)) input.lockPointer();
    followAspect(camera, surface);

    // Forward is where the camera looks, on the ground.
    const move = actions.vector('move', { x: 0, y: 0 });
    const { forward, right } = operator;
    const dir = {
      x: forward.x * move.y + right.x * move.x,
      z: forward.z * move.y + right.z * move.x,
    };
    const length = Math.hypot(dir.x, dir.z);
    speed += ((length > 0 ? 4.5 : 0) - speed) * Math.min(1, dt * 10);
    if (length > 0.01) {
      yaw = Math.atan2(dir.x, dir.z);
      dir.x /= length;
      dir.z /= length;
    }
    fall = character.grounded ? -1 : fall - 20 * dt;
    character.move({
      x: dir.x * speed * dt,
      y: fall * dt,
      z: dir.z * speed * dt,
    });
    physics.step(dt);
    physics.sync(1);
    visual.transform.rotation = axisAngle(0, 1, 0, yaw);
    animator.set('speed', speed);
    skinning.applyPose(animator.update(dt)).update();

    // The camera follows the feet, as drawn.
    const p = body.worldPosition;
    operator.focus = { x: p.x, y: p.y - 0.92, z: p.z };
    operator.update(dt);
    resources.update();
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.68, b: 0.75, a: 1 },
      prepare: (graph) => skinning.addPass(graph),
    });
    info(
      input.pointer.locked
        ? `WASD: walk · mouse: camera · wheel: closer · arm ${operator.arm.toFixed(1)} m of ${operator.distance.toFixed(1)}`
        : 'click to walk · WASD: walk · mouse: camera',
    );
  });
};

export default example;
