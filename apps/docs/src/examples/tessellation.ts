import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import { buildTerrain, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A terrain of 32 × 32 patches, displaced by a height map, flown over: each
// patch is tessellated as finely as its size on the screen asks, from 2 to
// 8192 triangles. Click to color the patches by level.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  const terrain = buildTerrain(backend, { size: 1024, height: 120 });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: 16 / 9,
      near: 0.5,
      far: 4000,
    },
  });
  const sun = new DirectionalLight({
    direction: { x: -0.5, y: -0.6, z: -0.4 },
    ambient: { x: 0.3, y: 0.32, z: 0.38 },
    diffuse: { x: 1, y: 0.95, z: 0.85 },
    specular: { x: 0.3, y: 0.3, z: 0.3 },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  let levels = false;
  canvas.addEventListener('click', () => {
    levels = !levels;
    terrain.showLevels(levels);
  });

  onFrame((time) => {
    // A circle over the hills, 30 m above the ground here and 60 m ahead,
    // looking ahead.
    const angle = 1 + time * 0.04;
    const x = Math.cos(angle) * 300;
    const z = Math.sin(angle) * 300;
    const ground = Math.max(
      terrain.heightAt(x, z),
      terrain.heightAt(x - Math.sin(angle) * 60, z + Math.cos(angle) * 60),
    );
    camera.position = { x, y: ground + 30, z };
    // Turned along the circle (about y), then down a little (about x):
    // the product of the two rotations, by their half angles.
    const yaw = (Math.PI - angle) / 2;
    const pitch = -0.125;
    camera.rotation = {
      x: Math.cos(yaw) * Math.sin(pitch),
      y: Math.sin(yaw) * Math.cos(pitch),
      z: -Math.sin(yaw) * Math.sin(pitch),
      w: Math.cos(yaw) * Math.cos(pitch),
    };
    followAspect(camera, surface);

    // The levels for this camera, then the frame.
    terrain.surface.update(camera, surface);
    renderer.render({
      items: [terrain.surface],
      camera,
      surface,
      lights: [sun],
      clearColor: { r: 0.62, g: 0.74, b: 0.88, a: 1 },
    });

    const stats = terrain.surface.stats;
    info(
      `${stats.drawn} of ${stats.patches} patches in view, ${Math.round(
        stats.triangles / 1000,
      )}k triangles (click: ${levels ? 'colors' : 'levels'})`,
    );
  });
};

export default example;
