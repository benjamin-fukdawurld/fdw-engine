import { Camera, DirectionalLight, Renderer } from '@fdw/engine-core';
import {
  createSky,
  GerstnerWaves,
  Ocean,
  OceanRenderer,
  OceanSpectrum,
} from '@fdw/engine-ocean';
import { axisAngle, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// The open sea, under a daylight sky. Its waves come from an ocean
// spectrum, computed on the GPU by FFTs every frame; click to switch to sums
// of Gerstner waves, computed in the vertex shader.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // The sky: what the water reflects, and the background.
  const sun = { x: 0.2, y: 0.35, z: -0.92 };
  const sky = createSky(backend, { sun });
  const light = new DirectionalLight({
    direction: { x: -sun.x, y: -sun.y, z: -sun.z },
    diffuse: { x: 2.6, y: 2.4, z: 2.1 },
  });

  // The waves: a sea built by a wind of 10 m/s, in three tiles of 233 m,
  // 37.7 m and 6.3 m; or six Gerstner waves.
  const spectrum = new OceanSpectrum(backend, {
    windSpeed: 10,
    windDirection: Math.PI / 2,
  });
  const gerstner = new GerstnerWaves([
    { direction: 1.5, wavelength: 40, amplitude: 0.6, steepness: 0.7 },
    { direction: 1.9, wavelength: 23, amplitude: 0.32, steepness: 0.6 },
    { direction: 1.2, wavelength: 12, amplitude: 0.15, steepness: 0.5 },
    { direction: 2.4, wavelength: 6.8, amplitude: 0.07, steepness: 0.5 },
    { direction: 0.8, wavelength: 3.3, amplitude: 0.03, steepness: 0.4 },
    { direction: 1.7, wavelength: 1.6, amplitude: 0.012, steepness: 0.3 },
  ]);
  // An ocean for each: its grid follows the camera, its material reads
  // the waves.
  const oceans = [spectrum, gerstner].map((waves) =>
    new Ocean({ waves, environment: sky }).setSun(light),
  );
  const names = ['ocean spectrum (FFT on the GPU)', 'Gerstner waves'];
  let current = 0;
  const show = () => info(`${names[current]} (click to switch)`);
  show();
  canvas.addEventListener('click', () => {
    current = 1 - current;
    show();
  });

  const renderer = new Renderer(backend);
  const oceanRenderer = new OceanRenderer(renderer, { toneMapping: 'neutral' });
  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 55,
      aspect: 16 / 9,
      near: 0.2,
      far: 5000,
    },
  });

  onFrame((time) => {
    // A slow turn, a few meters above the water, looking toward the sun.
    const yaw = 0.25 * Math.sin(time * 0.1);
    camera.position = { x: time * 2, y: 6, z: 0 };
    const turn = axisAngle(0, 1, 0, yaw);
    const tilt = axisAngle(1, 0, 0, -0.12);
    camera.rotation = {
      x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
      y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
      z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
      w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
    };
    followAspect(camera, surface);

    const ocean = oceans[current];
    // The waves at this time (the FFTs run on the GPU), the grid under the
    // camera.
    ocean.update(camera.position, time);
    // The scene (nothing here), the sky, then the sea over them.
    oceanRenderer.render({ ocean, camera, surface, time });
  });
};

export default example;
