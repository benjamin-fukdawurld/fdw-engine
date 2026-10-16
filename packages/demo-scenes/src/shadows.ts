import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  RenderItem,
  SpotLight,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from './geometry';
import { followAspect, SceneFactory } from './scene';

// PBR with uniform values: every object shares the same program.
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

// Shadows of a sun and of a spot sweeping the scene, antialiased edges (4
// samples per pixel): a ground, a ring of cubes turning around a sphere, a
// column.
export const createShadowsScene: SceneFactory = (backend, surface) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
    samples: 4,
  });

  const graph = pbrGraph();
  const material = (
    baseColor: [number, number, number],
    metallic = 0,
    roughness = 0.6,
  ) => new Material({ graph, values: { baseColor, metallic, roughness } });
  const cube = createCube();
  const sphere = createSphere(48, 24);

  const ground: RenderItem = {
    mesh: cube,
    material: material([0.6, 0.6, 0.6], 0, 0.9),
    transform: new Transform({
      position: { x: 0, y: -0.05, z: 0 },
      scale: { x: 12, y: 0.1, z: 12 },
    }),
  };
  const colors: [number, number, number][] = [
    [0.8, 0.2, 0.1],
    [0.9, 0.6, 0.1],
    [0.2, 0.6, 0.2],
    [0.1, 0.4, 0.8],
    [0.5, 0.2, 0.7],
    [0.9, 0.9, 0.9],
  ];
  const cubes = colors.map((color, i) => ({
    mesh: cube,
    material: material(color, i === 5 ? 1 : 0, i === 5 ? 0.3 : 0.6),
    transform: new Transform({ scale: { x: 0.6, y: 0.6, z: 0.6 } }),
  }));
  const items: RenderItem[] = [
    ground,
    ...cubes,
    {
      mesh: sphere,
      material: material([0.95, 0.65, 0.3], 1, 0.25),
      transform: new Transform({ position: { x: 0, y: 0.8, z: 0 } }),
    },
    {
      mesh: cube,
      material: material([0.8, 0.8, 0.75]),
      transform: new Transform({
        position: { x: -3, y: 1.5, z: -2 },
        scale: { x: 0.5, y: 3, z: 0.5 },
      }),
    },
  ];

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
    position: { x: 0, y: 5, z: 10 },
    rotation: axisAngle(1, 0, 0, -0.45),
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
      cubes.forEach((item, i) => {
        const angle = time * 0.4 + (i * Math.PI * 2) / cubes.length;
        item.transform.position = {
          x: 2.2 * Math.cos(angle),
          y: 0.3 + 0.2 * Math.sin(time * 2 + i),
          z: 2.2 * Math.sin(angle),
        };
        item.transform.rotation = axisAngle(0, 1, 0, time + i);
      });
      // The spot sweeps the scene.
      spot.direction = { x: Math.sin(time * 0.5) * 2, y: -5, z: -3 };
      renderer.render({
        items,
        camera,
        surface,
        time,
        lights: [sun, spot],
        clearColor: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
      });
    },
    destroy: () => renderer.destroy(),
  };
};
