import {
  AnimationGraphBuilder,
  Animator,
  rootMotionToWorld,
} from '@fdw/engine-animation';
import {
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { installGltf } from '@fdw/engine-gltf';
import { SceneCharacter } from '@fdw/engine-physics';
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

// A character moved by its animation: the clips carry the movement of the
// hips (root motion), the animator takes it out of the poses, and a
// character controller moves the character by it, against the crates of
// the scene. It walks straight, then turns left; ← holds the turn.
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
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.9,
  });
  const graph = g.build();
  const cube = createCube();
  const box = (
    position: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    color: [number, number, number],
  ) =>
    scene.root
      .add({ position, scale: size })
      .setMesh(cube, new Material({ graph, values: { color } }));
  // The ground, its top at 0, in tiles: the movement shows on it.
  for (let x = -6; x < 6; x++) {
    for (let z = -6; z < 6; z++) {
      box(
        { x: x * 2 + 1, y: -0.05, z: z * 2 + 1 },
        { x: 2, y: 0.1, z: 2 },
        (x + z) & 1 ? [0.36, 0.4, 0.33] : [0.3, 0.34, 0.28],
      );
    }
  }
  // Crates on the way.
  box({ x: -1.5, y: 0.5, z: 5 }, { x: 1, y: 1, z: 1 }, [0.75, 0.55, 0.3]);
  box({ x: 4, y: 0.75, z: 2 }, { x: 0.6, y: 1.5, z: 4 }, [0.6, 0.45, 0.3]);
  scene.root.add({ rotation: axisAngle(1, 0.4, 0.1, -0.95) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.3, y: 0.32, z: 0.36 },
      diffuse: { x: 1.4, y: 1.3, z: 1.2 },
    }),
  );

  const character = instantiate(handle, scene);
  const skinning = new Skinning(backend, character, model);
  const skeleton = skinning.skeleton;

  // The walk and the turn, blended by `turn`, in step. The movement of
  // the hips, and their turns, become the root motion.
  const a = new AnimationGraphBuilder('root motion');
  a.parameter('turn', 'number');
  a.output(
    a.blend(a.clip('Walk_RM'), a.clip('TurnLeft_RM'), a.param('turn'), {
      sync: true,
    }),
  );
  const animator = new Animator(a.build(), {
    skeleton,
    clips: clipsOf(model, skeleton),
    rootMotion: { joint: 'hips', rotation: true },
  });

  // The controller: a capsule against the renderers of the scene, but
  // those of the character.
  const own = new Set(character.nodes.map((node) => node.entity));
  const controller = new SceneCharacter(scene, {
    radius: 0.3,
    height: 1.8,
    position: { y: 0.92 },
    ignore: (entity) => own.has(entity),
  });

  let turning = false;
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
      turning = true;
      event.preventDefault();
    }
  });
  canvas.addEventListener('keyup', (event) => {
    if (event.code === 'ArrowLeft' || event.code === 'KeyA') turning = false;
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 60,
    },
  });
  const renderer = new Renderer(backend);

  let heading = 0;
  let turn = 0;
  let travelled = 0;
  let fall = 0;
  let previous: number | undefined;
  const step = { x: 0, y: 0, z: 0 };
  onFrame((time) => {
    let dt = previous === undefined ? time : time - previous;
    previous = time;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 60);
      dt -= h;
      const now = time - dt;
      // Straight for 3 s, then turning for 6 s, unless ← holds the turn.
      const target = turning || now % 9 > 3 ? 1 : 0;
      turn += Math.sign(target - turn) * Math.min(Math.abs(target - turn), h);
      animator.set('turn', turn);
      animator.update(h);
      // The movement of the clip, in the world: turned by the heading.
      const motion = animator.rootMotion;
      rootMotionToWorld(motion, heading, 1, step);
      heading += motion.yaw;
      fall = controller.grounded ? 0 : fall + 9.81 * h;
      const moved = controller.move({ x: step.x, y: -fall * h, z: step.z });
      travelled += Math.hypot(moved.movement.x, moved.movement.z);
    }
    const p = controller.position;
    character.root.transform.position = { x: p.x, y: p.y - 0.92, z: p.z };
    character.root.transform.rotation = axisAngle(0, 1, 0, heading);
    skinning.applyPose(animator.pose).update();

    // Behind and above, looking along the heading.
    camera.position = {
      x: p.x - Math.sin(heading) * 5,
      y: 3,
      z: p.z - Math.cos(heading) * 5,
    };
    camera.rotation = multiplyQuat(
      axisAngle(0, 1, 0, heading + Math.PI),
      axisAngle(1, 0, 0, -0.3),
    );
    followAspect(camera, surface);
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.72, b: 0.86, a: 1 },
      prepare: (graph) => skinning.addPass(graph),
    });
    info(
      `root motion · ${travelled.toFixed(1)} m · heading ${Math.round((heading * 180) / Math.PI) % 360}° · ${turn > 0.5 ? 'turning' : 'straight'} · ← turns`,
    );
  });
};

export default example;
