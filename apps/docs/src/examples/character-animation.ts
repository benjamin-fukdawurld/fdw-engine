import {
  AnimationGraphBuilder,
  Animator,
  BoneMask,
} from '@fdw/engine-animation';
import {
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { installGltf } from '@fdw/engine-gltf';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { clipsOf, Skinning } from '@fdw/engine-skinning';
import {
  axisAngle,
  createCube,
  followAspect,
  multiplyQuat,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A character loaded from a glTF file, skinned on the GPU and driven by an
// animation graph: idle, walk and run blended by its speed, a jump in a
// state machine, a wave of the hand on a layer of the upper body. It walks
// around a circle; its footsteps are events of the clips.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  const resources = new ResourceStore();
  resources.mount('http', new HttpSource({ base: '/fdw-engine/models/' }), {
    default: true,
  });
  installAssets(resources, { backend });
  installGltf(resources);
  const handle = resources.load<Model>(ModelType, 'character.glb');
  const model = await handle.ready;

  const scene = new Scene();
  const ground = new GraphBuilder('ground');
  ground.surface({
    shadingModel: 'pbr',
    baseColor: ground.uniform('color', BuiltinTypes.vec3f),
    roughness: 1,
  });
  scene.root
    .add({ position: { y: -0.05 }, scale: { x: 12, y: 0.1, z: 12 } })
    .setMesh(
      createCube(),
      new Material({
        graph: ground.build(),
        values: { color: [0.32, 0.36, 0.3] },
      }),
    );
  scene.root.add({ rotation: axisAngle(1, 0.4, 0.1, -0.95) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.3, y: 0.32, z: 0.36 },
      diffuse: { x: 1.4, y: 1.3, z: 1.2 },
    }),
  );

  // The character: its nodes in the scene, its meshes skinned.
  const character = instantiate(handle, scene);
  const skinning = new Skinning(backend, character, model);
  const skeleton = skinning.skeleton;

  // The clips of the file, and the moments of the footsteps.
  const clips = clipsOf(model, skeleton);
  clips['Walk'] = clips['Walk'].withEvents([
    { time: 0.22, name: 'step' },
    { time: 0.77, name: 'step' },
  ]);
  clips['Run'] = clips['Run'].withEvents([
    { time: 0.12, name: 'step' },
    { time: 0.45, name: 'step' },
  ]);

  // The graph: locomotion by speed, a jump, a wave over it.
  const g = new AnimationGraphBuilder('character');
  g.parameter('speed', 'number');
  g.parameter('jump', 'trigger');
  g.parameter('wave', 'number');
  const locomotion = g.blend1d(
    [g.clip('Idle'), g.clip('Walk'), g.clip('Run')],
    [0, 1.3, 3.6],
    g.param('speed'),
  );
  const body = g.stateMachine({
    label: 'body',
    states: { locomotion, jump: g.clip('Jump', { loop: false }) },
    transitions: [
      { from: 'locomotion', to: 'jump', trigger: 'jump', duration: 0.1 },
      { from: 'jump', to: 'locomotion', exitTime: 0.95, duration: 0.25 },
    ],
  });
  g.output(
    g.layer(body, g.clip('Wave'), {
      mask: 'rightArm',
      weight: g.param('wave'),
    }),
  );
  const animator = new Animator(g.build(), {
    skeleton,
    clips,
    masks: {
      rightArm: BoneMask.branches(skeleton, { 'upperArm.R': 1, head: 0.5 }),
    },
  });
  let steps = 0;
  animator.onEvent((event) => {
    if (event.name === 'step') steps++;
  });

  // The keys take over from the script: W and S change the speed, Space
  // jumps, E waves.
  let manual = false;
  let speed = 0;
  let waving = false;
  canvas.addEventListener('keydown', (event) => {
    manual = true;
    if (event.code === 'KeyW' || event.code === 'ArrowUp') {
      speed = Math.min(speed + 0.6, 3.6);
    } else if (event.code === 'KeyS' || event.code === 'ArrowDown') {
      speed = Math.max(speed - 0.6, 0);
    } else if (event.code === 'Space') {
      animator.trigger('jump');
    } else if (event.code === 'KeyE') {
      waving = !waving;
    } else {
      return;
    }
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  // A loop of 16 s: walk, run, jump, walk while waving, stop.
  const script = (t: number) => {
    const s = t % 16;
    const ramp = (from: number, to: number, a: number, b: number) =>
      from + (to - from) * Math.min(Math.max((s - a) / (b - a), 0), 1);
    return {
      speed:
        s < 4
          ? ramp(0, 1.3, 0, 0.5)
          : s < 10
            ? ramp(1.3, 3.6, 4, 5)
            : s < 15
              ? ramp(3.6, 1.3, 10, 11)
              : ramp(1.3, 0, 15, 15.4),
      jump: Math.floor(s * 30) === Math.floor(8.5 * 30),
      wave: s > 11.5 && s < 14.5 ? 1 : 0,
    };
  };

  // Around a circle, at the speed of the animation, posts inside it.
  const radius = 3;
  const post = new Material({
    graph: ground.build(),
    values: { color: [0.75, 0.55, 0.3] },
  });
  const cube = createCube();
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    scene.root
      .add({
        position: { x: Math.sin(a) * 1.6, y: 0.3, z: Math.cos(a) * 1.6 },
        scale: { x: 0.12, y: 0.6, z: 0.12 },
      })
      .setMesh(cube, post);
  }

  // The camera follows the character from outside the circle: a profile.
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 40,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const renderer = new Renderer(backend);

  let angle = 0;
  let previous: number | undefined;
  onFrame((time) => {
    // The first frame catches up with the clock: a stopped clock (the
    // reference images) shows the pose at that time.
    let dt = previous === undefined ? time : time - previous;
    previous = time;
    while (dt > 0) {
      const step = Math.min(dt, 1 / 30);
      dt -= step;
      const now = time - dt;
      const target = manual
        ? { speed, jump: false, wave: waving ? 1 : 0 }
        : script(now);
      animator.set('speed', target.speed).set('wave', target.wave);
      if (target.jump) animator.trigger('jump');
      angle += (target.speed * step) / radius;
      animator.update(step);
    }
    character.root.transform.position = {
      x: Math.sin(angle) * radius,
      z: Math.cos(angle) * radius,
    };
    // Facing along the circle, counterclockwise from above.
    character.root.transform.rotation = axisAngle(0, 1, 0, angle + Math.PI / 2);
    camera.position = {
      x: Math.sin(angle) * (radius + 4.5),
      y: 1.5,
      z: Math.cos(angle) * (radius + 4.5),
    };
    camera.rotation = multiplyQuat(
      axisAngle(0, 1, 0, angle),
      axisAngle(1, 0, 0, -0.1),
    );
    skinning.applyPose(animator.pose).update();

    followAspect(camera, surface);
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.72, b: 0.86, a: 1 },
    });
    const state = animator.state('body');
    info(
      `${skinning.mode} skinning · ${state?.state}${state?.next ? ` → ${state.next}` : ''} · speed ${(animator.get('speed') as number).toFixed(1)} m/s · ${steps} steps${manual ? '' : ' · W/S speed, Space jump, E wave'}`,
    );
  });
};

export default example;
