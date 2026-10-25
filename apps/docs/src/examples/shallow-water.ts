import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import { ShallowWater, WaterSurface } from '@fdw/engine-fluids';
import { createSky, OceanRenderer } from '@fdw/engine-ocean';
import {
  axisAngle,
  buildTerrain,
  followAspect,
  shoreGraph,
} from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A pool with an island, its water simulated on the GPU as a field of
// heights. Drops fall in it now and then; click to drop more. A spring
// pours water on the island, which runs down into the pool; a drain in a
// corner takes it away.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The ground: 16 m by 16 m, a pool 1.6 m deep in a bowl, a beach on one
  // side, an island.
  const size = 16;
  const height = 3;
  const level = 1.2;
  const resolution = 128;
  const cell = size / resolution;
  const smooth = (low: number, high: number, x: number) => {
    const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const groundAt = (x: number, z: number) => {
    const bowl =
      2.6 * smooth(4.5, 7.8, Math.max(Math.abs(x), Math.abs(z * 1.1)));
    const beach = Math.max(0, x + 1) * 0.22;
    const island = 1.9 * Math.exp(-((x + 2.5) ** 2 + (z + 2) ** 2) / 2.5);
    return Math.min(
      Math.max(bowl, beach * smooth(-1, 2, x)) +
        island -
        0.4 +
        0.4 * smooth(-3, 0, x),
      height,
    );
  };
  const heights = new Float32Array(resolution * resolution);
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const x = (i + 0.5) * cell - size / 2;
      const z = (j + 0.5) * cell - size / 2;
      heights[j * resolution + i] = Math.max(groundAt(x, z), 0) / height;
    }
  }
  const terrain = buildTerrain(backend, {
    size,
    height,
    resolution,
    heights,
    patches: 8,
    material: { graph: shoreGraph({ size, height, resolution, level }) },
  });

  // The water: the cells on the same points as the heights of the ground,
  // filled up to 1.2 m. The banks of the pool hold it.
  const water = new ShallowWater(backend, {
    resolution: [resolution, resolution],
    cell,
    origin: { x: -size / 2, z: -size / 2 },
    ground: heights.map((h) => h * height),
    level,
    maxDepth: 1.6,
  });
  water.addSource({ x: -2.5, z: -2, radius: 0.4, rate: 0.15 });
  // A drain in a corner takes as much away: the level stays.
  water.addSource({ x: 3.5, z: -3.5, radius: 0.5, rate: -0.26 });

  // Drawn with the material of the sea, through the passes that see
  // through the water.
  const sun = { x: 0.4, y: 0.7, z: 0.6 };
  const sky = createSky(backend, { sun });
  const light = new DirectionalLight({
    direction: { x: -sun.x, y: -sun.y, z: -sun.z },
    diffuse: { x: 1.9, y: 1.8, z: 1.6 },
    ambient: { x: 0.3, y: 0.35, z: 0.45 },
  });
  const waterSurface = new WaterSurface(water, {
    environment: sky,
    // Greener and less clear than the default: the depth shows.
    look: { absorption: [0.6, 0.18, 0.15] },
  }).setSun(light);
  const renderer = new Renderer(backend);
  const oceanRenderer = new OceanRenderer(renderer, { toneMapping: 'neutral' });
  const camera = new Camera({
    position: { x: 0, y: 6, z: 10.5 },
    rotation: axisAngle(1, 0, 0, -0.5),
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.1,
      far: 200,
    },
  });

  // A click drops water where the pointer is, on the plane of the water.
  canvas.addEventListener('pointerdown', (event) => {
    const box = canvas.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * 2 - 1;
    const y = 1 - ((event.clientY - box.top) / box.height) * 2;
    const projection = camera.projection;
    const tan =
      projection.type === 'perspective'
        ? Math.tan((projection.fov * Math.PI) / 360)
        : 1;
    const aspect = projection.type === 'perspective' ? projection.aspect : 1;
    // The ray of the pixel, turned by the tilt of the camera.
    const ray = { x: x * tan * aspect, y: y * tan, z: -1 };
    const c = Math.cos(-0.5);
    const s = Math.sin(-0.5);
    const dy = ray.y * c + ray.z * s;
    const dz = -ray.y * s + ray.z * c;
    const t = (level - camera.position.y) / dy;
    if (t > 0) {
      water.splash(
        camera.position.x + ray.x * t,
        camera.position.z + dz * t,
        0.4,
        0.15,
      );
    }
  });

  let last = 0;
  let clock = 0;
  let nextDrop = 0;
  let drops = 0;
  onFrame((time) => {
    // A step of the frame's duration; of 1/60 s when the clock is stopped
    // (the reference images): the water still moves.
    const dt = time > last ? Math.min(time - last, 1 / 30) : 1 / 60;
    last = time;
    clock += dt;
    if (clock >= nextDrop) {
      // Here and there, as rain would.
      water.splash(
        1 + 3 * Math.sin(drops * 2.4),
        1 + 2.5 * Math.cos(drops * 1.7),
        0.3,
        0.12,
      );
      drops++;
      nextDrop = clock + 1.1;
    }
    followAspect(camera, surface);
    water.update(dt);
    terrain.surface.update(camera, surface);
    oceanRenderer.render({
      ocean: waterSurface,
      items: [terrain.surface],
      lights: [light],
      camera,
      surface,
    });
    info(`${resolution}² cells · ${drops} drops · click to drop water`);
  });
};

export default example;
