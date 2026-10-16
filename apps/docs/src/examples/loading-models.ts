import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { installObj } from '@fdw/engine-obj';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, multiplyQuat } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Two models loaded from files: a tree in glTF, planted 40 times, and a
// sphere in OBJ with its MTL file and three maps. The trees share one mesh
// per primitive and one material each: drawn in a few calls.
const example: Example = async ({ backend, surface, onFrame, info }) => {
  const resources = new ResourceStore();
  // The files of public/models, under the base of the site.
  resources.mount('http', new HttpSource({ base: '/fdw-engine/models/' }), {
    default: true,
  });
  installAssets(resources, {
    backend,
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);
  installObj(resources);

  // The level: what it loads, released together when it is left.
  const level = resources.scope('forest');
  const tree = level.load<Model>(ModelType, 'tree.glb');
  const sphere = level.load<Model>(ModelType, 'sphere.obj');
  const loading = resources.group([tree, sphere]);
  // The progress counts the dependencies: the MTL file and the maps.
  const progress = () =>
    info(`loading ${Math.round(loading.progress.value * 100)} %`);
  const timer = setInterval(progress, 50);
  try {
    await loading.ready;
  } finally {
    clearInterval(timer);
  }

  const scene = new Scene();
  // The ground, a cube flattened, with a material of its own.
  const g = new GraphBuilder('ground');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 1,
  });
  scene.root
    .add({ position: { y: -0.05 }, scale: { x: 9, y: 0.1, z: 9 } })
    .setMesh(
      createCube(),
      new Material({ graph: g.build(), values: { color: [0.25, 0.32, 0.18] } })
    );

  // 40 instances of one model around a clearing, with some variety.
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      if (Math.abs(x) <= 1 && Math.abs(z) <= 1) continue;
      const size = 0.8 + random() * 0.6;
      instantiate(tree, scene, {
        position: {
          x: x * 1.2 + random() * 0.4,
          y: 0,
          z: z * 1.2 + random() * 0.4,
        },
        rotation: axisAngle(0, 1, 0, random() * Math.PI),
        scale: { x: size, y: size, z: size },
      });
    }
  }
  instantiate(sphere, scene, {
    position: { y: 0.8 },
    scale: { x: 0.8, y: 0.8, z: 0.8 },
  });
  scene.root
    .add({ rotation: axisAngle(1, 0.3, 0, -0.9) })
    .setLight(
      new DirectionalLight({
        castShadow: true,
        diffuse: { x: 1.2, y: 1.1, z: 1 },
      })
    );

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  const renderer = new Renderer(backend);

  onFrame((time) => {
    // A slow turn around the clearing.
    const angle = time * 0.15;
    camera.position = {
      x: Math.sin(angle) * 9,
      y: 5.5,
      z: Math.cos(angle) * 9,
    };
    camera.rotation = multiplyQuat(
      axisAngle(0, 1, 0, angle),
      axisAngle(1, 0, 0, -0.55)
    );
    resources.update();
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.55, g: 0.7, b: 0.85, a: 1 },
    });
    const stats = renderer.stats.get('scene');
    info(`${stats?.drawn ?? 0} items in ${stats?.drawCalls ?? 0} draw calls`);
  });
};

export default example;
