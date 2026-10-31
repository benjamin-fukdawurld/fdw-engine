import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A square at night, lit by 400 colored lamps drifting above the ground.
// Each pixel only sums the lamps of its cluster: those that reach it.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const output = { toneMapping: 'neutral', encoding: 'srgb' } as const;
  const renderer = new Renderer(backend, { output });
  // The same, every pixel summing every lamp: for comparison (C).
  const unclustered = new Renderer(backend, { output, lightClusters: false });

  const g = new GraphBuilder('pbr');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('baseColor', BuiltinTypes.vec3f),
    roughness: g.uniform('roughness', BuiltinTypes.f32),
  });
  const graph = g.build();
  const material = (baseColor: [number, number, number], roughness = 0.6) =>
    new Material({ graph, values: { baseColor, roughness } });

  const cube = createCube();
  const sphere = createSphere(24, 12);
  const items: RenderItem[] = [
    {
      mesh: cube,
      material: material([0.5, 0.5, 0.52], 0.4),
      transform: new Transform({
        position: { y: -0.5 },
        scale: { x: 60, y: 1, z: 60 },
      }),
    },
  ];
  // Columns and spheres in a grid, the lamps between them.
  const stone = material([0.75, 0.72, 0.68], 0.8);
  const metal = new Material({
    graph,
    values: { baseColor: [0.9, 0.9, 0.9], roughness: 0.25 },
  });
  for (let x = -24; x <= 24; x += 8) {
    for (let z = -24; z <= 24; z += 8) {
      items.push({
        mesh: cube,
        material: stone,
        transform: new Transform({
          position: { x, y: 1.5, z },
          scale: { x: 0.8, y: 3, z: 0.8 },
        }),
      });
      items.push({
        mesh: sphere,
        material: metal,
        transform: new Transform({ position: { x: x + 4, y: 0.6, z: z + 4 } }),
      });
    }
  }

  // The lamps: saturated colors, a range of about 3 m (the attenuation
  // falls below 1/256 of their color there).
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const lamps = Array.from({ length: 400 }, () => {
    const hue = random() * 6;
    const channel = (offset: number) =>
      Math.max(0, Math.min(1, Math.abs(((hue + offset) % 6) - 3) - 1));
    const color = { x: channel(0), y: channel(4), z: channel(2) };
    return {
      light: new PointLight({
        ambient: { x: 0, y: 0, z: 0 },
        diffuse: color,
        specular: color,
        quadraticAttenuation: 28,
      }),
      x: (random() - 0.5) * 56,
      z: (random() - 0.5) * 56,
      phase: random() * Math.PI * 2,
      speed: 0.2 + random() * 0.4,
    };
  });
  // A faint moonlight.
  const moon = new DirectionalLight({
    direction: { x: 0.3, y: -1, z: 0.5 },
    ambient: { x: 0.01, y: 0.012, z: 0.02 },
    diffuse: { x: 0.03, y: 0.04, z: 0.07 },
    specular: { x: 0, y: 0, z: 0 },
  });
  const lights = [moon, ...lamps.map(({ light }) => light)];

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 55,
      aspect: 16 / 9,
      near: 0.1,
      far: 120,
    },
  });

  // C: clusters, or every lamp for every pixel.
  let clustered = true;
  canvas.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyC') return;
    clustered = !clustered;
    event.preventDefault();
  });
  canvas.addEventListener('pointerdown', () => canvas.focus());

  let last = performance.now();
  let average = 16;
  onFrame((time) => {
    for (const lamp of lamps) {
      const angle = lamp.phase + time * lamp.speed;
      lamp.light.position = {
        x: lamp.x + Math.cos(angle) * 2,
        y: 0.5 + Math.sin(angle * 1.7) * 0.3,
        z: lamp.z + Math.sin(angle) * 2,
      };
    }
    // Circling above the square.
    const around = time * 0.05;
    camera.position = {
      x: Math.sin(around) * 30,
      y: 12,
      z: Math.cos(around) * 30,
    };
    camera.rotation = multiply(
      axisAngle(0, 1, 0, around),
      axisAngle(1, 0, 0, -0.38),
    );
    (clustered ? renderer : unclustered).render({
      items,
      camera,
      surface,
      lights,
      clearColor: { r: 0.01, g: 0.012, b: 0.02, a: 1 },
    });
    const now = performance.now();
    average = average * 0.95 + (now - last) * 0.05;
    last = now;
    info(
      `${renderer.stats.get('scene')?.lights ?? 0} lights in view · ${
        clustered ? 'clusters' : 'every light per pixel'
      } (C) · ${average.toFixed(1)} ms a frame`,
    );
  });
};

// The product of two rotations (quaternions as { x, y, z, w }).
function multiply(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export default example;
