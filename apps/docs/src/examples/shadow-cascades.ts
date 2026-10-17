import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { Scene } from '@fdw/engine-scene';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// An avenue of trees 300 m long under a low sun, the camera walking along
// it: one shadow map for all of it, or four cascades, sharp near the
// camera and coarser far away. A fog hides the end of the avenue.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.85,
  });
  const graph = g.build();
  const material = (color: [number, number, number]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const sphere = createSphere(16, 8);

  const scene = new Scene();
  scene.root
    .add({
      position: { y: -0.5, z: -140 },
      scale: { x: 120, y: 1, z: 340 },
      static: true,
    })
    .setMesh(cube, material([0.45, 0.42, 0.35]));
  // Two rows of trees, every 6 m, and a few posts between them.
  const bark = material([0.35, 0.24, 0.15]);
  const leaves = material([0.2, 0.42, 0.15]);
  for (let z = 10; z > -300; z -= 6) {
    for (const x of [-7, 7]) {
      const trunk = scene.root
        .add({
          position: { x, y: 3, z },
          scale: { x: 0.5, y: 6, z: 0.5 },
          static: true,
        })
        .setMesh(cube, bark);
      trunk
        .add({ position: { y: 0.55 }, scale: { x: 7, y: 0.45, z: 7 } })
        .setMesh(sphere, leaves);
    }
    scene.root
      .add({
        position: { x: 2.5, y: 0.6, z: z - 3 },
        scale: { x: 0.25, y: 1.2, z: 0.25 },
        static: true,
      })
      .setMesh(cube, material([0.6, 0.6, 0.55]));
  }
  // A low sun, from the side: long shadows across the avenue.
  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.25, y: 0.28, z: 0.32 },
    diffuse: { x: 2.4, y: 2.2, z: 1.9 },
  });
  scene.root.add({ rotation: axisAngle(0.35, 1, 0.1, -0.6) }).setLight(sun);

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 16 / 9,
      near: 0.1,
      far: 400,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
    // Four cascades of 1024 px each.
    shadowAtlasSize: 2048,
  });

  // C: one shadow map or four cascades; F: the fog.
  let cascades = true;
  let fogged = true;
  canvas.addEventListener('keydown', (event) => {
    if (event.code === 'KeyC') cascades = !cascades;
    else if (event.code === 'KeyF') fogged = !fogged;
    else return;
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  onFrame((time) => {
    // Walking down the avenue, and back.
    const z = 5 - (1 - Math.cos(time * 0.08)) * 120;
    camera.position = { x: 0, y: 1.7, z };
    camera.rotation = axisAngle(1, 0, 0, -0.06);
    sun.shadow = cascades ? { cascades: { count: 4, distance: 120 } } : {};
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.62, g: 0.7, b: 0.78, a: 1 },
      ...(fogged
        ? { fog: { color: { r: 0.5, g: 0.57, b: 0.64 }, density: 0.012 } }
        : {}),
    });
    const stats = renderer.stats.get('scene');
    info(
      `${cascades ? 'four cascades' : 'one shadow map'} (C) · fog ${
        fogged ? 'on' : 'off'
      } (F) · ${stats?.shadowMaps ?? 0} shadow maps, ${stats?.casters ?? 0} casters`,
    );
  });
};

export default example;
