import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { FluidBodies, SmokeGrid, SmokeRenderer } from '@fdw/engine-fluids';
import {
  axisAngle,
  createCube,
  createSphere,
  followAspect,
} from '@fdw/demo-scenes';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { Example } from './runtime';

// Fire and smoke in a grid of cells: a fire burns on a brazier, its hot
// smoke rises and swirls around a ball swaying above it. Click to switch
// between the fire and a chimney that blows cold smoke sideways.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // 2.4 m wide, twice as high; fewer cells where the compute is emulated.
  const emulated = backend.capabilities?.emulatedCompute;
  const [nx, ny, nz] = emulated ? [32, 64, 32] : [48, 96, 48];
  const cell = 2.4 / nx;
  const smoke = new SmokeGrid(backend, {
    resolution: [nx, ny, nz],
    cell,
    origin: { x: -1.2, y: 0, z: -1.2 },
    vorticity: 3,
    buoyancy: 2,
    cooling: 1.6,
    extinction: 10,
  });
  const fire = {
    x: 0,
    y: 0.3,
    z: 0,
    radius: 0.32,
    density: 4,
    temperature: 6,
    turbulence: 0.85,
  };
  const chimney = {
    x: -0.7,
    y: 0.6,
    z: 0,
    radius: 0.22,
    density: 4,
    temperature: 0.8,
    velocity: { x: 1.6, y: 1.2, z: 0 },
  };
  let emitter = smoke.addEmitter(fire);
  canvas.addEventListener('click', () => {
    smoke.removeEmitter(emitter);
    emitter = smoke.addEmitter(emitter === fire ? chimney : fire);
  });

  // The ball: a shape moved by the example, an obstacle for the smoke.
  const bodies = new FluidBodies(backend);
  const ball = new Transform({ scale: { x: 0.7, y: 0.7, z: 0.7 } });

  const sun = { x: 0.45, y: 0.75, z: 0.5 };
  const light = new DirectionalLight({
    direction: { x: -sun.x, y: -sun.y, z: -sun.z },
    diffuse: { x: 2.4, y: 2.25, z: 2 },
    ambient: { x: 0.35, y: 0.4, z: 0.5 },
  });
  const renderer = new Renderer(backend);
  const smokeRenderer = new SmokeRenderer(renderer, { toneMapping: 'neutral' });
  // The light of the sun through the smoke, and its look.
  smokeRenderer.setSun(smoke, light).setLook(smoke, {
    albedo: [0.45, 0.45, 0.47],
    fireIntensity: 0.4,
  });

  const g = new GraphBuilder('lit');
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
    roughness: 0.8,
  });
  const graph = g.build();
  const material = (color: number[]) =>
    new Material({ graph, values: { color } });
  const cube = createCube();
  const items = [
    {
      mesh: cube,
      material: material([0.22, 0.21, 0.2]),
      transform: new Transform({
        position: { x: 0, y: -0.05, z: 0 },
        scale: { x: 12, y: 0.1, z: 12 },
      }),
    },
    {
      mesh: cube,
      material: material([0.15, 0.13, 0.12]),
      transform: new Transform({
        position: { x: 0, y: 0.08, z: 0 },
        scale: { x: 0.7, y: 0.16, z: 0.7 },
      }),
    },
    {
      mesh: createSphere(32, 16),
      material: material([0.6, 0.62, 0.66]),
      transform: ball,
    },
  ];
  const camera = new Camera({
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
    // The ball sways above the fire; the air around it moves with it.
    const x = 0.3 * Math.sin(clock * 0.7);
    const position = { x, y: 1.9, z: 0 };
    bodies
      .clearShapes()
      .addShape({
        shape: { type: 'sphere', radius: 0.35 },
        position,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        center: position,
        velocity: { x: 0.21 * Math.cos(clock * 0.7), y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      })
      .update();
    ball.position = position;
    smoke.update(dt, bodies);

    // A slow turn around the fire, looking a little down.
    const yaw = 0.35 + clock * 0.05;
    camera.position = {
      x: 5.5 * Math.sin(yaw),
      y: 2.6,
      z: 5.5 * Math.cos(yaw),
    };
    const turn = axisAngle(0, 1, 0, yaw);
    const tilt = axisAngle(1, 0, 0, -0.17);
    camera.rotation = {
      x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
      y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
      z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
      w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
    };
    followAspect(camera, surface);
    smokeRenderer.render({
      smoke,
      items,
      lights: [light],
      camera,
      surface,
      clearColor: { r: 0.42, g: 0.55, b: 0.72, a: 1 },
    });
    info(
      `${nx} × ${ny} × ${nz} cells · ${emitter === fire ? 'fire' : 'chimney'} (click to switch)`,
    );
  });
};

export default example;
