import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  SpotLight,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A sun and a sweeping spot casting shadows on a few PBR objects.
const example: Example = ({ backend, surface, onFrame }) => {
  // Linear lighting, tone mapped for display; 4 samples per pixel.
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
    samples: 4,
  });

  // One graph for every object: the values are uniforms.
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
    metallic: number,
    roughness: number
  ) => new Material({ graph, values: { baseColor, metallic, roughness } });

  const cube = createCube();
  const sphere = createSphere(48, 24);
  const ground: RenderItem = {
    mesh: cube,
    material: material([0.6, 0.6, 0.6], 0, 0.9),
    transform: new Transform({
      position: { x: 0, y: -0.05, z: 0 },
      scale: { x: 10, y: 0.1, z: 10 },
    }),
  };
  const ball: RenderItem = {
    mesh: sphere,
    material: material([0.95, 0.65, 0.3], 1, 0.25),
    transform: new Transform({ position: { x: 0, y: 0.8, z: 0 } }),
  };
  const box: RenderItem = {
    mesh: cube,
    material: material([0.2, 0.45, 0.8], 0, 0.5),
    transform: new Transform({ scale: { x: 0.7, y: 0.7, z: 0.7 } }),
  };
  const items = [ground, ball, box];

  const sun = new DirectionalLight({
    direction: { x: -0.6, y: -1, z: -0.4 },
    ambient: { x: 0.04, y: 0.045, z: 0.05 },
    diffuse: { x: 1.3, y: 1.2, z: 1.1 },
    specular: { x: 1.3, y: 1.2, z: 1.1 },
    castShadow: true,
  });
  const spot = new SpotLight({
    position: { x: 0, y: 5, z: 3 },
    ambient: { x: 0, y: 0, z: 0 },
    diffuse: { x: 0.4, y: 0.8, z: 1.6 },
    specular: { x: 0.4, y: 0.8, z: 1.6 },
    innerCutoff: 20,
    outerCutoff: 30,
    quadraticAttenuation: 0.02,
    castShadow: true,
  });

  const camera = new Camera({
    position: { x: 0, y: 4, z: 8 },
    rotation: axisAngle(1, 0, 0, -0.45),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });

  onFrame((time) => {
    // The box turns around the ball; the spot sweeps the scene.
    box.transform.position = {
      x: 2 * Math.cos(time * 0.6),
      y: 0.35,
      z: 2 * Math.sin(time * 0.6),
    };
    box.transform.rotation = axisAngle(0, 1, 0, time);
    spot.direction = { x: Math.sin(time * 0.5) * 2, y: -5, z: -3 };
    renderer.render({
      items,
      camera,
      surface,
      time,
      lights: [sun, spot],
      clearColor: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
    });
  });
};

export default example;
