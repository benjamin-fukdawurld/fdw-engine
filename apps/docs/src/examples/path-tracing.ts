import {
  Camera,
  Material,
  PointLight,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { PathTracer, RayScene } from '@fdw/engine-raytracing';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A path traced room: the light bounces off the red and green walls onto
// the white ones, the lamp of the ceiling lights the room softly. The
// frames add up while nothing moves, the noise fades. Click to switch
// between the path tracer and the rasterization of the same scene.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    metallic: g.uniform('metallic', BuiltinTypes.f32),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  const graph = g.build();
  const material = (
    baseColor: [number, number, number],
    metallic = 0,
    roughness = 0.9,
  ) => new Material({ graph, values: { baseColor, metallic, roughness } });
  // The lamp: unlit, its color is its light (emission).
  const lamp = new GraphBuilder('lamp');
  lamp.surface({ baseColor: [3, 2.8, 2.4] });

  const cube = createCube();
  const sphere = createSphere(48, 24);
  const white = material([0.8, 0.8, 0.78]);
  const box = (
    look: Material,
    position: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    angle = 0,
  ): RenderItem => ({
    mesh: cube,
    material: look,
    transform: new Transform({
      position,
      scale,
      rotation: axisAngle(0, 1, 0, angle),
    }),
  });
  // A room of 4 × 4 × 4 m, open towards the camera.
  const items: RenderItem[] = [
    box(white, { x: 0, y: -0.05, z: 0 }, { x: 4, y: 0.1, z: 4 }),
    box(white, { x: 0, y: 4.05, z: 0 }, { x: 4, y: 0.1, z: 4 }),
    box(white, { x: 0, y: 2, z: -2.05 }, { x: 4, y: 4, z: 0.1 }),
    box(material([0.75, 0.12, 0.1]), { x: -2.05, y: 2, z: 0 }, { x: 0.1, y: 4, z: 4 }),
    box(material([0.15, 0.6, 0.15]), { x: 2.05, y: 2, z: 0 }, { x: 0.1, y: 4, z: 4 }),
    box(new Material({ graph: lamp.build() }), { x: 0, y: 3.98, z: 0 }, { x: 1.2, y: 0.05, z: 1.2 }),
    box(white, { x: -0.7, y: 1.2, z: -0.6 }, { x: 1.1, y: 2.4, z: 1.1 }, 0.35),
    {
      mesh: sphere,
      material: material([0.95, 0.95, 0.95], 1, 0.05),
      transform: new Transform({
        position: { x: 0.8, y: 0.6, z: 0.6 },
        scale: { x: 1.2, y: 1.2, z: 1.2 },
      }),
    },
  ];
  // The light of the lamp, for the rasterization and for the rays of the
  // path tracer towards the lights (the lamp itself is found by bouncing).
  const light = new PointLight({
    position: { x: 0, y: 3.7, z: 0 },
    ambient: { x: 0.05, y: 0.05, z: 0.05 },
    diffuse: { x: 1.5, y: 1.4, z: 1.2 },
    specular: { x: 1.5, y: 1.4, z: 1.2 },
    quadraticAttenuation: 0.15,
  });
  const camera = new Camera({
    position: { x: 0, y: 2, z: 7.5 },
    projection: { type: 'perspective', fov: 38, aspect: 16 / 9, near: 0.1, far: 100 },
  });

  const tracer = backend.capabilities?.rayQuery
    ? new PathTracer(renderer, new RayScene(backend), {
        bounces: 4,
        // Outside the room: night.
        sky: {
          zenith: { x: 0, y: 0, z: 0 },
          horizon: { x: 0, y: 0, z: 0 },
          ground: { x: 0, y: 0, z: 0 },
        },
      })
    : undefined;
  let traced = tracer !== undefined;
  canvas.addEventListener('click', () => {
    traced = tracer !== undefined && !traced;
  });

  onFrame((time) => {
    if (!tracer || !traced) {
      renderer.render({ items, camera, surface, time, lights: [light], clearColor: { r: 0, g: 0, b: 0, a: 1 } });
      info(tracer ? 'rasterized · click to switch' : 'rasterized: tracing rays needs WebGPU');
      return;
    }
    // The scene of the rays, then a frame of paths, added to the others.
    tracer.scene.update({ items });
    tracer.render({ camera, surface, lights: [light], time });
    info(`path traced, ${tracer.frames} frames · click to switch`);
  });
};

export default example;
