import { AnimationGraphBuilder, Animator } from '@fdw/engine-animation';
import {
  installAssets,
  instantiate,
  ModelType,
  type Model,
} from '@fdw/engine-assets';
import { Camera, DirectionalLight, Material, Renderer } from '@fdw/engine-core';
import { installGltf } from '@fdw/engine-gltf';
import { PathTracer, RayScene } from '@fdw/engine-raytracing';
import { HttpSource, ResourceStore } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { clipsOf, Skinning } from '@fdw/engine-skinning';
import {
  axisAngle,
  buildTerrain,
  createCube,
  followAspect,
  multiplyQuat,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// What the GPU moves, seen by the rays: a character skinned on the GPU
// walks over a terrain of patches made in the vertex stage; the shadows
// of the character and of the hills are traced by rays. Click to switch
// between the shadow maps, the traced shadows and the path tracer.
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

  // The terrain: a hill and its valleys, 30 m across. Its rays see a mesh
  // of its patches (terrain.surface.rayMesh), made from the same heights.
  const terrain = buildTerrain(backend, {
    size: 30,
    height: 2,
    resolution: 64,
    patches: 8,
    // Fine enough for the shadows of the hills on themselves: 32 × 32
    // quads a patch.
    rayLevel: 5,
    seed: 7,
  });

  const scene = new Scene();
  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.25, y: 0.27, z: 0.32 },
    diffuse: { x: 1.5, y: 1.4, z: 1.25 },
  });
  scene.root.add({ rotation: axisAngle(1, 0.6, 0.2, -0.8) }).setLight(sun);

  // Posts around the path: their shadows on the slopes.
  const g = new GraphBuilder('post');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.8,
  });
  const post = new Material({
    graph: g.build(),
    values: { color: [0.75, 0.55, 0.3] },
  });
  const cube = createCube();
  const radius = 4;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = Math.sin(a) * (radius + 1.2);
    const z = Math.cos(a) * (radius + 1.2);
    scene.root
      .add({
        position: { x, y: terrain.heightAt(x, z) + 0.5, z },
        scale: { x: 0.15, y: 1, z: 0.15 },
      })
      .setMesh(cube, post);
  }

  // The character, skinned on the GPU, walking.
  const character = instantiate(handle, scene);
  const skinning = new Skinning(backend, character, model);
  const builder = new AnimationGraphBuilder('walk');
  builder.output(builder.clip('Walk'));
  const animator = new Animator(builder.build(), {
    skeleton: skinning.skeleton,
    clips: clipsOf(model, skinning.skeleton),
  });

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // The rays, where the backend traces them (WebGPU, Vulkan).
  const rays = backend.capabilities?.rayQuery
    ? new RayScene(backend, { registry: renderer.registry })
    : undefined;
  const sky = { x: 0.55, y: 0.68, z: 0.85 };
  const tracer = rays
    ? new PathTracer(renderer, rays, {
        bounces: 2,
        sky: {
          zenith: sky,
          horizon: { x: 0.8, y: 0.85, z: 0.9 },
          ground: { x: 0.3, y: 0.3, z: 0.28 },
        },
      })
    : undefined;
  const modes = rays
    ? (['shadow maps', 'traced shadows', 'path traced'] as const)
    : (['shadow maps'] as const);
  let mode = rays ? 1 : 0;
  canvas.addEventListener('click', () => {
    mode = (mode + 1) % modes.length;
  });

  let angle = 0;
  let previous: number | undefined;
  onFrame((time) => {
    const dt = Math.min(previous === undefined ? time : time - previous, 0.1);
    previous = time;
    angle += (1.3 * dt) / radius;
    animator.update(dt);
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    character.root.transform.position = { x, y: terrain.heightAt(x, z), z };
    character.root.transform.rotation = axisAngle(0, 1, 0, angle + Math.PI / 2);
    camera.position = { x: x * 2.4, y: terrain.heightAt(x, z) + 3, z: z * 2.4 };
    camera.rotation = multiplyQuat(
      axisAngle(0, 1, 0, angle),
      axisAngle(1, 0, 0, -0.3),
    );
    followAspect(camera, surface);
    const target = surface.getCurrentTarget();
    terrain.surface.update(camera, {
      width: target.width,
      height: target.height,
    });
    skinning.applyPose(animator.pose).update();

    const clearColor = { r: 0.6, g: 0.72, b: 0.86, a: 1 };
    const items = [terrain.surface];
    if (!rays || mode === 0) {
      renderer.render({
        source: scene,
        items,
        camera,
        surface,
        clearColor,
        prepare: (graph) => skinning.addPass(graph),
      });
    } else {
      // The skinning first: the rays see the vertices of this frame.
      skinning.dispatch();
      rays.update({ source: scene, items });
      if (modes[mode] === 'path traced' && tracer) {
        tracer.render({ camera, surface, lights: [sun] });
      } else {
        renderer.render({
          source: scene,
          items,
          camera,
          surface,
          clearColor,
          rays: { scene: rays, shadows: { offset: 0.05 } },
        });
      }
    }
    info(
      rays
        ? `${modes[mode]}${modes[mode] === 'path traced' ? ` (${tracer?.frames} frames)` : ''} · click to switch`
        : 'shadow maps: tracing rays needs WebGPU',
    );
  });
};

export default example;
