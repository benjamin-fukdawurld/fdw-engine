import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { RayScene } from '@fdw/engine-raytracing';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// Shadows traced by rays: each pixel of the materials traces a ray towards
// the sun. Click to switch between the shadow maps, hard traced shadows and
// soft ones (8 rays per pixel across the disk of the sun).
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  const graph = g.build();
  const material = (baseColor: [number, number, number], roughness = 0.7) =>
    new Material({ graph, values: { baseColor, roughness } });

  // A colonnade under a beam, a ball and a lattice on a floor: thin shapes
  // and long shadows, where the shadow maps show their texels.
  const cube = createCube();
  const sphere = createSphere(48, 24);
  const stone = material([0.75, 0.72, 0.68]);
  const box = (
    position: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    look = stone,
  ): RenderItem => ({
    mesh: cube,
    material: look,
    transform: new Transform({ position, scale }),
  });
  const items: RenderItem[] = [
    box({ x: 0, y: -0.05, z: 0 }, { x: 16, y: 0.1, z: 12 }, material([0.5, 0.52, 0.55])),
    box({ x: 0, y: 2.6, z: -1 }, { x: 7, y: 0.25, z: 0.6 }),
  ];
  for (let k = 0; k < 6; k++) {
    items.push(box({ x: -3 + k * 1.2, y: 1.25, z: -1 }, { x: 0.3, y: 2.5, z: 0.3 }));
  }
  // A lattice of thin bars: their shadows a fine grid.
  for (let k = 0; k < 9; k++) {
    items.push(
      box({ x: 3.2, y: 0.9 + k * 0.08 - 0.32, z: 1.6 }, { x: 1.6, y: 0.025, z: 0.025 }, material([0.2, 0.2, 0.22])),
      box({ x: 2.56 + k * 0.16, y: 0.9, z: 1.6 }, { x: 0.025, y: 0.7, z: 0.025 }, material([0.2, 0.2, 0.22])),
    );
  }
  const ball: RenderItem = {
    mesh: sphere,
    material: material([0.9, 0.45, 0.2], 0.4),
    transform: new Transform({ position: { x: -1.5, y: 0.6, z: 1.8 }, scale: { x: 1.2, y: 1.2, z: 1.2 } }),
  };
  items.push(ball);

  const sun = new DirectionalLight({
    direction: { x: -1, y: -0.8, z: -0.6 },
    ambient: { x: 0.08, y: 0.09, z: 0.11 },
    diffuse: { x: 1.4, y: 1.3, z: 1.15 },
    specular: { x: 1.4, y: 1.3, z: 1.15 },
    castShadow: true,
  });
  const camera = new Camera({
    position: { x: 0, y: 4.5, z: 9 },
    rotation: axisAngle(1, 0, 0, -0.42),
    projection: { type: 'perspective', fov: 45, aspect: 16 / 9, near: 0.1, far: 100 },
  });

  // The scene of the rays, where the backend traces them (WebGPU, Vulkan).
  const scene = backend.capabilities?.rayQuery ? new RayScene(backend) : undefined;
  const modes = scene
    ? (['shadow maps', 'traced', 'traced, soft'] as const)
    : (['shadow maps'] as const);
  let mode = scene ? 2 : 0;
  canvas.addEventListener('click', () => {
    mode = (mode + 1) % modes.length;
  });

  onFrame((time) => {
    ball.transform.position = { x: -1.5 + Math.sin(time * 0.7) * 1.2, y: 0.6, z: 1.8 };
    const soft = modes[mode] === 'traced, soft';
    // The sun is half a degree wide: its tangent.
    sun.shadow = { softness: soft ? 0.03 : 0 };
    // The scene of the rays follows the items: moved objects, new ones.
    scene?.update({ items });
    renderer.render({
      items,
      camera,
      surface,
      time,
      lights: [sun],
      clearColor: { r: 0.45, g: 0.55, b: 0.7, a: 1 },
      ...(scene && mode > 0
        ? { rays: { scene, shadows: soft ? { samples: 8 } : true } }
        : {}),
    });
    info(
      scene
        ? `${modes[mode]} · click to switch`
        : 'shadow maps: tracing rays needs WebGPU',
    );
  });
};

export default example;
