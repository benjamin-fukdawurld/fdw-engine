import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import {
  FluidBodies,
  ParticleFluid,
  ParticleFluidRenderer,
} from '@fdw/engine-fluids';
import { createSky } from '@fdw/engine-ocean';
import { axisAngle, createCube, followAspect } from '@fdw/demo-scenes';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { Example } from './runtime';

// A liquid of particles on the GPU: a block of water falls in a tank and
// splashes against its far wall (a dam that breaks), then a paddle stirs
// it. Click to break the dam again.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // Fewer particles where the compute is emulated (WebGL2).
  const emulated = backend.capabilities?.emulatedCompute;
  const tank = { min: [-1.2, 0, -0.5], max: [1.2, 1.5, 0.5] } as const;
  const liquid = new ParticleFluid(backend, {
    count: emulated ? 4096 : 16384,
    radius: emulated ? 0.03 : 0.02,
    bounds: tank,
  });
  const breakDam = () => {
    liquid.clear();
    liquid.addBlock([-1.2, 0, -0.5], [-0.3, 0.9, 0.5]);
  };
  breakDam();
  canvas.addEventListener('click', breakDam);

  // The paddle: a board moved by the example, which pushes the particles.
  const bodies = new FluidBodies(backend);
  const half = { x: 0.03, y: 0.3, z: 0.35 };
  const paddle = new Transform({
    scale: { x: half.x * 2, y: half.y * 2, z: half.z * 2 },
  });

  // Drawn in screen space: the spheres of the particles melted into a
  // surface, lit as water.
  const sun = { x: 0.4, y: 0.75, z: 0.55 };
  const sky = createSky(backend, { sun });
  const light = new DirectionalLight({
    direction: { x: -sun.x, y: -sun.y, z: -sun.z },
    diffuse: { x: 2.4, y: 2.25, z: 2 },
    ambient: { x: 0.35, y: 0.4, z: 0.5 },
  });
  const renderer = new Renderer(backend);
  const liquidRenderer = new ParticleFluidRenderer(renderer, {
    environment: sky,
    toneMapping: 'neutral',
    look: { absorption: [1.6, 0.5, 0.35], scatterColor: [0.01, 0.05, 0.07] },
  }).setSun(light);

  // The tank: its floor and three walls (the front one left out).
  const g = new GraphBuilder('tank');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.7,
  });
  const graph = g.build();
  const cube = createCube();
  const slab = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: number[],
  ) => ({
    mesh: cube,
    material: new Material({ graph, values: { color } }),
    transform: new Transform({
      position: { x, y, z },
      scale: { x: sx, y: sy, z: sz },
    }),
  });
  const items = [
    slab(0, -0.05, 0, 12, 0.1, 12, [0.3, 0.29, 0.27]),
    slab(0, 0.75, -0.54, 2.4, 1.5, 0.08, [0.16, 0.2, 0.24]),
    slab(-1.24, 0.75, 0, 0.08, 1.5, 1, [0.14, 0.17, 0.2]),
    slab(1.24, 0.75, 0, 0.08, 1.5, 1, [0.14, 0.17, 0.2]),
    {
      mesh: cube,
      material: new Material({ graph, values: { color: [0.7, 0.5, 0.25] } }),
      transform: paddle,
    },
  ];
  // In front of the tank: turned toward it, tilted down.
  const turn = axisAngle(0, 1, 0, 0.3);
  const tilt = axisAngle(1, 0, 0, -0.3);
  const camera = new Camera({
    position: { x: 1, y: 1.4, z: 3.3 },
    rotation: {
      x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
      y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
      z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
      w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
    },
    projection: {
      type: 'perspective',
      fov: 50,
      aspect: 16 / 9,
      near: 0.05,
      far: 100,
    },
  });

  let last = 0;
  let clock = 0;
  onFrame((time) => {
    // Steps of 1/60 s when the clock is stopped (the reference images).
    const dt = time > last ? Math.min(time - last, 1 / 30) : 1 / 60;
    last = time;
    clock += dt;
    // The paddle sweeps along the tank after the dam broke.
    const sweep = Math.max(clock - 3, 0);
    const x = 0.8 * Math.sin(sweep * 0.8);
    const position = { x, y: half.y + 0.05, z: 0 };
    bodies
      .clearShapes()
      .addShape({
        shape: { type: 'box', halfExtents: half },
        position,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        center: position,
        velocity: {
          x: sweep > 0 ? 0.64 * Math.cos(sweep * 0.8) : 0,
          y: 0,
          z: 0,
        },
        angularVelocity: { x: 0, y: 0, z: 0 },
      })
      .update();
    paddle.position = position;
    liquid.update(dt, bodies);
    followAspect(camera, surface);
    liquidRenderer.render({
      liquid,
      items,
      lights: [light],
      camera,
      surface,
      clearColor: { r: 0.42, g: 0.55, b: 0.72, a: 1 },
    });
    info(`${liquid.active} particles · click to break the dam again`);
  });
};

export default example;
