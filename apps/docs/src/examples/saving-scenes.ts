import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import {
  bitmapCodec,
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { installGltf, writeGltf } from '@fdw/engine-gltf';
import { HttpSource, MemorySource, ResourceStore } from '@fdw/engine-resources';
import { createImageBitmapDecoder } from '@fdw/engine-resources-web';
import { Scene, type Node } from '@fdw/engine-scene';
import {
  captureScene,
  installSceneIo,
  instantiateScene,
  SceneDataType,
  writeFdwScene,
  type ExportedFile,
  type SceneInstance,
} from '@fdw/engine-scene-io';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import {
  axisAngle,
  createCube,
  createSphere,
  multiplyQuat,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A scene saved as a file of the engine and loaded back: its nodes, the
// meshes and materials made in code (written with it), a model by its URI,
// a light, and a component of the application. At the start, the scene is
// built, saved, cleared and loaded: what is drawn is the loaded one.
// Shuffle moves the objects, Load brings the saved scene back; Download
// and glTF give the files.
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
  // Where the scene is saved: files in memory, under a scheme of their own.
  const saved = new MemorySource();
  resources.mount('saved', saved);
  installAssets(resources, {
    backend,
    codecs: [bitmapCodec(createImageBitmapDecoder())],
  });
  installGltf(resources);
  installSceneIo(resources);
  // Held for the time of the example: the instances clone it.
  const fir = resources.load<Model>(ModelType, 'forest/fir.glb');
  await fir.ready;

  const scene = new Scene();
  // A component of the application, saved field by field: how fast a node
  // turns around its vertical axis.
  const Spin = scene.world.defineComponent(
    'spin',
    { speed: 'f32' },
    { persist: true },
  );

  // The scene, built in code.
  const g = new GraphBuilder('painted');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.7,
  });
  const graph = g.build();
  const paint = (color: [number, number, number], label: string) =>
    new Material({ graph, values: { color }, label });
  const build = (into: Node) => {
    into
      .add({
        name: 'ground',
        position: { y: -0.05 },
        scale: { x: 10, y: 0.1, z: 7 },
      })
      .setMesh(createCube(), paint([0.3, 0.36, 0.24], 'grass'));
    const cube = createCube();
    const red = paint([0.8, 0.3, 0.2], 'red');
    for (let i = 0; i < 4; i++) {
      into
        .add({
          name: `crate ${i + 1}`,
          position: { x: -3 + i * 2, y: 0.5, z: 1.5 },
        })
        .setMesh(cube, red)
        .attach(Spin, { speed: 0.4 + i * 0.3 });
    }
    into
      .add({ name: 'ball', position: { x: 2.5, y: 0.8, z: -1.2 } })
      .setMesh(createSphere(), paint([0.3, 0.55, 0.85], 'blue'));
    // A model by its URI: the scene keeps the reference, not the meshes.
    instantiate(fir, into.scene, {
      parent: into,
      name: 'fir',
      position: { x: -1, y: 0, z: -1.5 },
      scale: { x: 0.35, y: 0.35, z: 0.35 },
    });
    into.add({ name: 'sun', rotation: axisAngle(1, 0.3, 0, -0.9) }).setLight(
      new DirectionalLight({
        castShadow: true,
        diffuse: { x: 1.2, y: 1.1, z: 1 },
      }),
    );
  };

  // Saving: the scene as data, then as the files of the format.
  const path = 'level.scene.json';
  let files: ExportedFile[] = [];
  const save = async () => {
    const data = captureScene(scene, {
      store: resources,
      uri: `saved:${path}`,
      name: 'level',
    });
    files = await writeFdwScene(data, path);
    for (const file of files) saved.set(file.path, file.bytes);
    // Loaded before: the store reads the new files (between two frames).
    await resources.reload(`saved:${path}`);
    resources.update();
  };
  // Loading: through the store, as any resource.
  let loaded: SceneInstance | undefined;
  const clear = () => {
    loaded?.dispose();
    loaded = undefined;
    for (const node of [...scene.root.children]) node.remove();
  };
  const load = async () => {
    clear();
    const handle = resources.load(SceneDataType, `saved:${path}`);
    loaded = await instantiateScene(handle, scene, { store: resources });
    handle.release();
  };

  build(scene.root);
  await save();
  await load();

  // Buttons over the canvas.
  const host = canvas.parentElement as HTMLElement;
  host.style.position = 'relative';
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;left:8px;top:8px;display:flex;gap:4px;flex-wrap:wrap;font:12px sans-serif';
  host.append(bar);
  const button = (label: string, action: () => Promise<void> | void) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.style.cssText =
      'margin:0;padding:2px 8px;border:1px solid #666;border-radius:4px;background:#222c;color:#eee;cursor:pointer';
    element.addEventListener('click', () => void action());
    bar.append(element);
  };
  const download = (file: ExportedFile, type: string) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([file.bytes], { type }));
    link.download = file.path;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  button('Shuffle', () => {
    let seed = Math.round(performance.now()) | 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    scene.root.traverse((node) => {
      if (node.name.startsWith('crate') || node.name === 'ball') {
        const p = node.transform.position;
        node.transform.position = {
          x: p.x + (random() - 0.5) * 2,
          y: p.y,
          z: p.z + (random() - 0.5) * 2,
        };
      }
    });
  });
  button('Save', save);
  button('Clear', clear);
  button('Load', load);
  button('Download', async () => {
    const data = captureScene(scene, { store: resources, name: 'level' });
    const [file] = await writeFdwScene(data, path, { binary: 'embedded' });
    download(file, 'application/json');
  });
  button('glTF', async () => {
    const uri = `saved:${path}`;
    const data = captureScene(scene, {
      store: resources,
      uri,
      instances: 'expand',
    });
    const [file] = await writeGltf(data, 'level.glb', {
      store: resources,
      uri,
    });
    download(file, 'model/gltf-binary');
  });

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 50,
    },
  });
  camera.position = { x: 0, y: 5, z: 9 };
  camera.rotation = multiplyQuat(
    axisAngle(0, 1, 0, 0),
    axisAngle(1, 0, 0, -0.5),
  );
  const renderer = new Renderer(backend);
  const size = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

  onFrame((time) => {
    // The application's system: the nodes with a spin turn.
    for (const entity of Spin.entities) {
      scene.node(entity).transform.rotation = axisAngle(
        0,
        1,
        0,
        time * Spin.speed[entity],
      );
    }
    resources.update();
    renderer.render({
      source: scene,
      camera,
      surface,
      clearColor: { r: 0.55, g: 0.7, b: 0.85, a: 1 },
    });
    info(
      `${loaded ? 'loaded from' : 'cleared ·'} ${files
        .map((f) => `${f.path} (${size(f.bytes.byteLength)})`)
        .join(' + ')}`,
    );
  });
};

export default example;
