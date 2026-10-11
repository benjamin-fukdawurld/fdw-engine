import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { Scene } from '@fdw/engine-scene';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A forest of trees in a scene: static trunks and crowns, a few birds
// flying between them, and a camera flying over it. Only what the camera
// sees is drawn.
const example: Example = ({ backend, surface, onFrame, info }) => {
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.8,
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const bark = material([0.35, 0.22, 0.12]);
  const leaves = material([0.15, 0.45, 0.12]);
  const grass = material([0.3, 0.42, 0.18]);
  const feathers = material([0.9, 0.85, 0.2]);
  const cube = createCube();
  const sphere = createSphere(16, 8);

  const scene = new Scene();
  // The ground, and 4000 trees: a trunk, and a crown as its child. Static:
  // indexed once, never updated.
  scene.root
    .add({
      position: { y: -0.5 },
      scale: { x: 400, y: 1, z: 400 },
      static: true,
    })
    .setMesh(cube, grass);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) {
    const height = 2 + random() * 3;
    const trunk = scene.root
      .add({
        position: {
          x: random() * 380 - 190,
          y: height / 2,
          z: random() * 380 - 190,
        },
        scale: { x: 0.4, y: height, z: 0.4 },
        static: true,
      })
      .setMesh(cube, bark);
    // In the space of the trunk: its scale applies to the crown.
    trunk
      .add({ position: { y: 0.6 }, scale: { x: 6, y: 0.5, z: 6 } })
      .setMesh(sphere, leaves);
  }
  // Birds: dynamic nodes, moved every frame.
  const birds = Array.from({ length: 200 }, () =>
    scene.root
      .add({
        position: { x: random() * 300 - 150, y: 8, z: random() * 300 - 150 },
      })
      .setMesh(sphere, feathers)
  );
  scene.root.add({ rotation: axisAngle(1, 0, 0, -1) }).setLight(
    new DirectionalLight({
      castShadow: true,
      diffuse: { x: 1.2, y: 1.1, z: 1 },
    })
  );

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.5,
      far: 150,
    },
  });
  // The camera is a node too: it follows its node.
  const eye = scene.root.add({ position: { y: 12 } }).setCamera(camera);
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  onFrame((time) => {
    eye.transform.position = {
      x: Math.sin(time * 0.1) * 120,
      z: Math.cos(time * 0.1) * 120,
    };
    eye.transform.rotation = axisAngle(0, 1, 0, time * 0.1 + Math.PI);
    birds.forEach((bird, i) => {
      bird.transform.position = { y: 8 + Math.sin(time * 2 + i) * 2 };
    });
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.55, g: 0.7, b: 0.9, a: 1 },
    });
    const stats = renderer.stats.get('scene');
    if (stats) {
      info(
        `${stats.drawn} of 8201 objects drawn, ${stats.casters} shadow casters`
      );
    }
  });
};

export default example;
