import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  Renderer,
  RenderItem,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { createSphere } from './geometry';
import { followAspect, SceneFactory } from './scene';

// PBR metallic/roughness, the values being uniforms: every sphere shares the
// same program.
function pbrGraph() {
  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    metallic: g.uniform('metallic', BuiltinTypes.f32),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  return g.build();
}

const steps = 5;

// A grid of spheres: metallic from 0 (bottom) to 1 (top), roughness from 0
// (left) to 1 (right), lit by a key light and a moving point light.
export const createPbrScene: SceneFactory = (backend, surface) => {
  // Linear lighting, compressed for display by the Khronos PBR Neutral
  // tone mapping, then encoded in sRGB.
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  // Colors are linear.
  const graph = pbrGraph();
  const sphere = createSphere(48, 24);
  const items: RenderItem[] = [];
  for (let row = 0; row < steps; row++) {
    for (let column = 0; column < steps; column++) {
      items.push({
        mesh: sphere,
        material: new Material({
          graph,
          values: {
            baseColor: [0.9, 0.35, 0.1],
            metallic: row / (steps - 1),
            roughness: column / (steps - 1),
          },
        }),
        transform: new Transform({
          position: {
            x: (column - (steps - 1) / 2) * 1.2,
            y: (row - (steps - 1) / 2) * 1.2,
            z: 0,
          },
        }),
      });
    }
  }

  const keyLight = new DirectionalLight({
    direction: { x: -0.5, y: -0.6, z: -1 },
    ambient: { x: 0.03, y: 0.03, z: 0.03 },
    diffuse: { x: 1.6, y: 1.5, z: 1.4 },
    specular: { x: 1.6, y: 1.5, z: 1.4 },
  });
  const movingLight = new PointLight({
    position: { x: 0, y: 0, z: 3 },
    ambient: { x: 0, y: 0, z: 0 },
    diffuse: { x: 0.6, y: 0.8, z: 1.5 },
    specular: { x: 0.6, y: 0.8, z: 1.5 },
    quadraticAttenuation: 0.1,
  });

  const camera = new Camera({
    position: { x: 0, y: 0, z: 9 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 1,
      near: 0.1,
      far: 100,
    },
  });

  return {
    frame: (time) => {
      followAspect(camera, surface);
      movingLight.position = {
        x: 3 * Math.cos(time * 0.7),
        y: 2 * Math.sin(time * 0.7),
        z: 3,
      };
      renderer.render({
        items,
        camera,
        surface,
        time,
        exposure: 1,
        lights: [keyLight, movingLight],
        clearColor: { r: 0.02, g: 0.02, b: 0.025, a: 1 },
      });
    },
    destroy: () => renderer.destroy(),
  };
};
