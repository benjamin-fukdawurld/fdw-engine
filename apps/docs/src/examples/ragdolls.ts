import {
  AnimationGraphBuilder,
  Animator,
  type Pose,
} from '@fdw/engine-animation';
import {
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { installGltf } from '@fdw/engine-gltf';
import { Shapes } from '@fdw/engine-physics';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { Ragdoll, type RagdollBone } from '@fdw/engine-ragdoll';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { clipsOf, Skinning } from '@fdw/engine-skinning';
import { axisAngle, createCube, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Characters walking in place until a blow knocks them down: their
// ragdoll, bodies on the bones linked by joints, takes over from the
// animation, from the pose of the moment. Space knocks the next one down,
// R stands them up again.
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

  const engine = await createRapierPhysics();
  const world = engine.createWorld();
  const scene = new Scene();
  const g = new GraphBuilder('ground');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 1,
  });
  scene.root
    .add({ position: { y: -0.05 }, scale: { x: 14, y: 0.1, z: 10 } })
    .setMesh(
      createCube(),
      new Material({ graph: g.build(), values: { color: [0.34, 0.37, 0.32] } }),
    );
  world.createBody({
    type: 'static',
    position: { y: -0.5 },
    colliders: [{ shape: Shapes.box(7, 0.5, 5) }],
  });
  scene.root.add({ rotation: axisAngle(1, 0.4, 0.1, -0.95) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.3, y: 0.32, z: 0.36 },
      diffuse: { x: 1.4, y: 1.3, z: 1.2 },
    }),
  );

  // The bodies of the character: capsules from joint to joint, spheres
  // for the head; hinges at the elbows and the knees.
  const limb = (side: 'L' | 'R'): RagdollBone[] => [
    { joint: `upperArm.${side}`, to: `lowerArm.${side}`, radius: 0.05 },
    {
      joint: `lowerArm.${side}`,
      to: `hand.${side}`,
      radius: 0.045,
      link: 'hinge',
      limits: [-2.4, 0.2],
    },
    { joint: `upperLeg.${side}`, to: `lowerLeg.${side}`, radius: 0.075 },
    {
      joint: `lowerLeg.${side}`,
      to: `foot.${side}`,
      radius: 0.06,
      link: 'hinge',
      limits: [-0.1, 2.4],
    },
  ];
  const bones: RagdollBone[] = [
    { joint: 'hips', to: 'spine', radius: 0.13 },
    { joint: 'spine', to: 'neck', radius: 0.13 },
    { joint: 'head', radius: 0.12 },
    ...limb('L'),
    ...limb('R'),
  ];

  // The walk in place, for everyone.
  const a = new AnimationGraphBuilder('walk');
  a.output(a.clip('Walk'));
  const graph = a.build();

  const people = [-3, 0, 3].map((x, i) => {
    const character = instantiate(handle, scene, {
      position: { x, z: 0 },
      rotation: axisAngle(0, 1, 0, 0.4 * (i - 1)),
    });
    const skinning = new Skinning(backend, character, model);
    const skeleton = skinning.skeleton;
    const animator = new Animator(graph, {
      skeleton,
      clips: clipsOf(model, skeleton),
    });
    // Out of step with each other.
    animator.update(0.37 * i);
    const ragdoll = new Ragdoll(world, skeleton, {
      bones,
      // In group 2, colliding with group 1 (the ground) only.
      groups: 2,
      mask: 1,
    });
    return {
      character,
      skinning,
      animator,
      ragdoll,
      pose: skeleton.rest.clone() as Pose,
    };
  });

  let knocked = 0;
  const knock = () => {
    const person = people[knocked % people.length];
    knocked++;
    if (person.ragdoll.active) return;
    // The node of the skeleton (the parent of its root joint), and a
    // blow from the camera side, upward.
    const frame = person.character.nodes[0].worldMatrix;
    person.ragdoll.activate(person.animator.pose, frame, {
      x: 0.5,
      y: 1.5,
      z: -4,
    });
  };
  const reset = () => {
    for (const person of people) person.ragdoll.deactivate();
    knocked = 0;
  };
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'Space') knock();
    else if (event.code === 'KeyR') reset();
    else return;
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const camera = new Camera({
    position: { x: 0, y: 2.2, z: 7.5 },
    rotation: axisAngle(1, 0, 0, -0.2),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const renderer = new Renderer(backend);

  // A loop of 8 s: one knocked down every second from 0.5 s, all up at 7.
  const script = (t: number, h: number) => {
    const s = t % 8;
    const before = s - h;
    for (const at of [0.5, 1.5, 2.5]) {
      if (before < at && s >= at) knock();
    }
    if (before < 7 && s >= 7) reset();
  };

  let previous: number | undefined;
  onFrame((time) => {
    let dt = previous === undefined ? time : time - previous;
    previous = time;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 60);
      dt -= h;
      script(time - dt, h);
      world.step(h);
      for (const person of people) {
        if (!person.ragdoll.active) person.animator.update(h);
      }
    }
    for (const person of people) {
      const pose = person.ragdoll.active
        ? person.ragdoll.readPose(person.pose)
        : person.animator.pose;
      person.skinning.applyPose(pose).update();
    }
    followAspect(camera, surface);
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.6, g: 0.72, b: 0.86, a: 1 },
      prepare: (graph) => {
        for (const person of people) person.skinning.addPass(graph);
      },
    });
    info(
      `${people.filter((p) => p.ragdoll.active).length} of ${people.length} down · ${bones.length} bodies each · Space: knock down · R: stand up`,
    );
  });
};

export default example;
