// Renders a model to a PNG with Dawn in Node: to look at what the asset
// tools write without a browser. The model is framed from its bounds, lit
// by a sun with shadows, on a grey ground.
// Usage: node --import jiti/register tools/assets/preview.ts <model.glb>
//   [--out preview.png] [--size 768] [--yaw 30] [--pitch 15] [--zoom 1]
//   [--copies 1] [--spacing 0] [--node name]
import { parseArgs } from 'node:util';
import { basename, dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import {
  installAssets,
  instantiate,
  ModelType,
  pixelCodec,
  type Model,
} from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { ResourceStore } from '@fdw/engine-resources';
import {
  createStbImageDecoder,
  FileSource,
} from '@fdw/engine-resources-native';
import { rotationOf } from '@fdw/engine-camera';
import { Aabb } from '@fdw/engine-geometry';
import { Scene } from '@fdw/engine-scene';
import { clipsOf, Skinning } from '@fdw/engine-skinning';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { WebGpuEngine, WebGpuOffscreenSurface } from '@fdw/engine-webgpu';
import { axisAngle, createCube } from '@fdw/demo-scenes';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'preview.png' },
    size: { type: 'string', default: '768' },
    yaw: { type: 'string', default: '30' },
    pitch: { type: 'string', default: '15' },
    zoom: { type: 'string', default: '1' },
    copies: { type: 'string', default: '1' },
    spacing: { type: 'string', default: '0' },
    // Node names, one per copy: each copy shows only the meshes under its
    // node (to compare the levels of detail side by side).
    show: { type: 'string' },
    // A clip of the model and the time to pose it at.
    clip: { type: 'string' },
    time: { type: 'string', default: '0' },
  },
});
const file = resolve(positionals[0] ?? '');
const size = Number(values.size);

const dawn = await import('webgpu');
Object.assign(globalThis, dawn.globals);
const engine = new WebGpuEngine({ gpu: dawn.create([]) });
await engine.init();
const backend = engine.backend;
const surface = new WebGpuOffscreenSurface(size, size);
await surface.init(engine);

const resources = new ResourceStore();
resources.mount('file', new FileSource(dirname(file)), { default: true });
installAssets(resources, {
  backend,
  codecs: [pixelCodec(createStbImageDecoder())],
});
installGltf(resources);
const handle = resources.load<Model>(ModelType, basename(file));
const model = await handle.ready;

const scene = new Scene();
const shown = values.show?.split(',');
const copies = shown?.length ?? Number(values.copies);
const roots = [];
const instances = [];
for (let i = 0; i < copies; i++) {
  const instance = instantiate(model, scene, {});
  instances.push(instance);
  const root = instance.root;
  roots.push(root);
  if (shown) {
    // Hidden, then the branch of the node shown made visible again.
    root.traverse((node) => (node.visible = false));
    root.visible = true;
    root.traverse((node) => {
      if (node.name !== shown[i]) return;
      node.traverse((n) => (n.visible = true));
      for (let n = node.parent; n; n = n.parent) n.visible = true;
    });
  }
}
// Posed by a clip: the skinned vertices are computed before the bounds.
const skinnings = values.clip
  ? roots.map((_, i) => {
      const instance = instances[i];
      const skinning = new Skinning(backend, instance, model);
      const clip = clipsOf(model, skinning.skeleton)[values.clip!];
      if (!clip) {
        throw new Error(
          `no clip ${values.clip}: ${Object.keys(clipsOf(model, skinning.skeleton)).join(', ')}`,
        );
      }
      const pose = skinning.skeleton.rest.clone();
      clip.sample(Number(values.time), pose);
      return skinning.applyPose(pose).update();
    })
  : [];

// The bounds of the copies, all at the origin, then side by side along x.
const bounds = scene.bounds(new Aabb());
const box = {
  min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
  max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
};
const extent = {
  x: box.max.x - box.min.x,
  y: box.max.y - box.min.y,
  z: box.max.z - box.min.z,
};
const spacing = Number(values.spacing) || extent.x * 1.1;
roots.forEach((root, i) => {
  root.transform.position = { x: (i - (copies - 1) / 2) * spacing };
});
const width = extent.x + spacing * (copies - 1);

const g = new GraphBuilder('ground');
g.surface({
  shadingModel: 'pbr',
  baseColor: g.uniform('color', BuiltinTypes.vec3f),
  roughness: 1,
});
const radius = Math.max(width, extent.y, extent.z) * 2;
scene.root
  .add({
    position: { y: box.min.y - 0.01 },
    scale: { x: radius, y: 0.01, z: radius },
  })
  .setMesh(
    createCube(),
    new Material({ graph: g.build(), values: { color: [0.35, 0.35, 0.33] } }),
  );
scene.root.add({ rotation: axisAngle(1, 0.3, 0.2, -0.9) }).setLight(
  new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.35, y: 0.37, z: 0.42 },
    diffuse: { x: 2.4, y: 2.3, z: 2.1 },
  }),
);

const center = {
  x: (box.min.x + box.max.x) / 2,
  y: (box.min.y + box.max.y) / 2,
  z: (box.min.z + box.max.z) / 2,
};
const yaw = (Number(values.yaw) * Math.PI) / 180;
const pitch = (Number(values.pitch) * Math.PI) / 180;
const distance =
  (Math.max(width, extent.y) * 1.25) / Number(values.zoom) + extent.z / 2;
const camera = new Camera({
  projection: {
    type: 'perspective',
    fov: 50,
    aspect: 1,
    near: distance / 100,
    far: distance * 10,
  },
});
camera.position = {
  x: center.x + Math.sin(yaw) * Math.cos(pitch) * distance,
  y: center.y + Math.sin(pitch) * distance,
  z: center.z + Math.cos(yaw) * Math.cos(pitch) * distance,
};
camera.rotation = rotationOf(yaw, -pitch);

const renderer = new Renderer(backend, {
  output: { toneMapping: 'neutral', encoding: 'srgb' },
});
const started = performance.now();
renderer.render({
  source: scene,
  camera,
  surface,
  clearColor: { r: 0.62, g: 0.72, b: 0.82, a: 1 },
  prepare: (graph) => skinnings.forEach((skinning) => skinning.addPass(graph)),
});
const pixels = await surface.readPixels();
await sharp(Buffer.from(pixels), {
  raw: { width: size, height: size, channels: 4 },
})
  .png()
  .toFile(values.out);
console.log(
  `${values.out}: ${Math.round(performance.now() - started)} ms,`,
  JSON.stringify(renderer.stats.get('scene') ?? {}),
);
surface.destroy();
await engine.destroy();
