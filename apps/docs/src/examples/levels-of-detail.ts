import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { findLodGroups, Scene, SceneLods } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// 400 firs of three levels of detail each: the finest near the camera,
// coarser further, none beyond 300 m. Their levels are nodes named
// fir_a_LOD0, fir_a_LOD1… in the model.
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
  installAssets(resources, {
    backend,
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);
  const handle = resources.load<Model>(ModelType, 'forest/fir.glb');
  const timer = setInterval(
    () => info(`loading ${Math.round(handle.progress.value * 100)} %`),
    50,
  );
  try {
    await handle.ready;
  } finally {
    clearInterval(timer);
  }

  const scene = new Scene();
  const g = new GraphBuilder('ground');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 1,
  });
  scene.root
    .add({
      position: { y: -0.5 },
      scale: { x: 400, y: 1, z: 400 },
      static: true,
    })
    .setMesh(
      createCube(),
      new Material({ graph: g.build(), values: { color: [0.3, 0.27, 0.2] } }),
    );
  scene.root.add({ rotation: axisAngle(0.5, 1, 0.3, -0.75) }).setLight(
    new DirectionalLight({
      castShadow: true,
      ambient: { x: 0.3, y: 0.33, z: 0.32 },
      diffuse: { x: 2.4, y: 2.2, z: 1.9 },
      shadow: { cascades: { count: 3, distance: 150 } },
    }),
  );

  // The levels of each fir, chosen for the camera by a system.
  const lods = new SceneLods(scene);
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    const kind = ['fir_a', 'fir_b', 'fir_c'][i % 3];
    const angle = random() * Math.PI * 2;
    const scale = 0.8 + random() * 0.4;
    const fir = instantiate(handle, scene, {
      position: {
        x: (i % 20) * 9 - 85 + random() * 4,
        y: 0,
        z: -Math.floor(i / 20) * 9 + random() * 4,
      },
      rotation: axisAngle(0, 1, 0, angle),
      scale: { x: scale, y: scale, z: scale },
    });
    // The model holds the three firs: this one keeps one of them.
    for (const { group, levels } of findLodGroups(fir.root)) {
      if (group.name !== kind) {
        group.visible = false;
        continue;
      }
      lods.add(group, [
        { nodes: [levels[0]], maxDistance: 30 },
        { nodes: [levels[1]], maxDistance: 80 },
        { nodes: [levels[2]], maxDistance: 300 },
      ]);
    }
  }
  const groups = [...lods.Lod.entities];

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 55,
      aspect: 16 / 9,
      near: 0.1,
      far: 400,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
    shadowAtlasSize: 2048,
  });

  // L: the levels, or the finest everywhere (a bias that never coarsens).
  let levels = true;
  canvas.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyL') return;
    levels = !levels;
    lods.bias = levels ? 1 : 1e6;
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  onFrame((time) => {
    // Walking into the forest, and out.
    const z = 20 - (1 - Math.cos(time * 0.1)) * 70;
    camera.position = { x: -4, y: 2, z };
    camera.rotation = axisAngle(0, 1, 0, 0.15 + Math.sin(time * 0.2) * 0.3);
    lods.update(camera);
    resources.update();
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.62, g: 0.7, b: 0.76, a: 1 },
      fog: { color: { r: 0.5, g: 0.57, b: 0.6 }, density: 0.01 },
    });
    const counts = [0, 0, 0, 0];
    for (const group of groups) counts[lods.level(group) + 1]++;
    const stats = renderer.stats.get('scene');
    info(
      `${levels ? 'levels of detail' : 'finest everywhere'} (L) · LOD0 ${counts[1]} · LOD1 ${counts[2]} · LOD2 ${counts[3]} · none ${counts[0]} · ${stats?.drawCalls ?? 0} draws`,
    );
  });
};

export default example;
