import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { FlyActions, FlyOperator } from '@fdw/engine-camera';
import { installGltf } from '@fdw/engine-gltf';
import { ActionMap, Input } from '@fdw/engine-input';
import { WebInputSource } from '@fdw/engine-input-web';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { Scene } from '@fdw/engine-scene';
import { axisAngle, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A walk in a city block: a glTF model of 550 m by 550 m, in centimeters,
// loaded with its textures, and a camera at the height of the eyes. The
// shadows follow the walker: sharp around them, none far away.
const example: Example = async ({
  backend,
  surface,
  canvas,
  onFrame,
  info,
}) => {
  // The keys and the right button drive the example, not the page.
  canvas.addEventListener('keydown', (event) => {
    if (event.code.startsWith('Arrow') || event.code === 'Space') {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', () => canvas.focus());

  const resources = new ResourceStore();
  resources.mount('http', new HttpSource({ base: '/fdw-engine/models/' }), {
    default: true,
  });
  installAssets(resources, {
    backend,
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);

  // 25 MB, 21 textures: the progress while they come.
  const city = resources.load<Model>(ModelType, 'modern_city_block.glb');
  const timer = setInterval(
    () => info(`loading ${Math.round(city.progress.value * 100)} %`),
    50,
  );
  try {
    await city.ready;
  } finally {
    clearInterval(timer);
  }

  const scene = new Scene();
  // The model is in centimeters: a scale of 0.01 makes it meters, the unit
  // of the camera and its speed.
  instantiate(city, scene, { scale: { x: 0.01, y: 0.01, z: 0.01 } });
  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.25, y: 0.27, z: 0.3 },
    diffuse: { x: 2.2, y: 2.1, z: 1.9 },
  });
  scene.root.add({ rotation: axisAngle(1, 0.4, 0.2, -0.9) }).setLight(sun);

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 65,
      aspect: 16 / 9,
      near: 0.1,
      far: 1000,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // Walking: WASD, Shift to run, the pointer locked to look around.
  const input = new Input(new WebInputSource(canvas));
  const actions = new ActionMap(input, FlyActions);
  const fly = new FlyOperator(camera, actions, {
    mode: 'walk',
    position: { x: -34, y: 1.7, z: 189 },
    yaw: 0.87,
    speed: 4,
    pointerSpeed: 2,
  });

  let previous: number | undefined;
  onFrame((time) => {
    const dt = Math.min(0.1, time - (previous ?? time));
    previous = time;
    input.update();
    // A click locks the pointer; Escape releases it, in the browser.
    if (!input.pointer.locked && input.pointer.pressed(0)) {
      input.lockPointer();
    }
    followAspect(camera, surface);
    fly.update(dt);
    // The shadow map covers 80 m around the walker, not the whole block.
    sun.shadow = { bounds: { center: fly.position, radius: 80 } };
    resources.update();
    renderer.render({
      source: scene,
      camera,
      surface,
      time,
      clearColor: { r: 0.55, g: 0.7, b: 0.9, a: 1 },
    });
    info(
      input.pointer.locked
        ? 'WASD: walk · Shift: run · Q/E: up, down · Esc: release'
        : 'click to look around · WASD: walk',
    );
  });
};

export default example;
