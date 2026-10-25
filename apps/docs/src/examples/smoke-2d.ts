import { Camera, Material, Renderer, Transform } from '@fdw/engine-core';
import { FluidBodies, SmokeGrid, smokePlaneGraph } from '@fdw/engine-fluids';
import { createPlane, createSphere } from '@fdw/demo-scenes';
import { GraphBuilder } from '@fdw/engine-shader';
import type { Example } from './runtime';

// Smoke in a plane: a grid of 128 × 192 cells, one deep. A fire at the
// bottom heats the air, which rises in swirls around a disc; move the
// pointer over the canvas to move the disc through the smoke.
const example: Example = ({ backend, surface, canvas, onFrame, info }) => {
  // 2.56 m wide, 3.84 m high, cells of 2 cm; open above and on the sides.
  const smoke = new SmokeGrid(backend, {
    resolution: [128, 192, 1],
    cell: 0.02,
    origin: { x: -1.28, y: 0, z: -0.01 },
    vorticity: 4,
    buoyancy: 3,
    cooling: 1.2,
  });
  smoke.addEmitter({
    x: 0,
    y: 0.25,
    z: 0,
    radius: 0.18,
    density: 4,
    temperature: 6,
    turbulence: 0.8,
  });
  smoke.sunDirection = [0.5, 0.8, 0];

  // The view: the height of the grid, 16:9.
  const view = { width: 3.84 * (16 / 9), height: 3.84 };

  // The disc: a ball cut by the plane, an obstacle for the smoke.
  const bodies = new FluidBodies(backend);
  const disc = { x: 0, y: 1.2, radius: 0.22 };
  let velocity = { x: 0, y: 0 };
  canvas.addEventListener('pointermove', (event) => {
    const box = canvas.getBoundingClientRect();
    const u = (event.clientX - box.left) / box.width;
    const v = 1 - (event.clientY - box.top) / box.height;
    // Where the pointer is in the view; the disc pushes the air as it moves.
    const x = (u - 0.5) * view.width;
    const y = v * view.height;
    velocity = { x: (x - disc.x) * 30, y: (y - disc.y) * 30 };
    disc.x = x;
    disc.y = y;
  });

  // The smoke on a quad over the grid, blended over a dark background.
  const material = new Material({
    graph: smokePlaneGraph(smoke.layout),
    renderState: { alphaMode: 'blend' },
    values: { smokeShade: smoke.shade, extinction: 10 },
  });
  const quad = {
    mesh: createPlane(),
    material,
    // The plane of the mesh is xz: turned to face the camera.
    transform: new Transform({
      position: { x: 0, y: 1.92, z: 0 },
      rotation: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
      scale: { x: 2.56, y: 1, z: 3.84 },
    }),
  };
  const g = new GraphBuilder('disc');
  g.surface({ baseColor: [0.75, 0.75, 0.8] });
  const ball = {
    mesh: createSphere(32, 16),
    material: new Material({ graph: g.build() }),
    transform: new Transform(),
  };
  const renderer = new Renderer(backend);
  const camera = new Camera({
    position: { x: 0, y: 0, z: 5 },
    projection: {
      type: 'orthographic',
      left: -view.width / 2,
      right: view.width / 2,
      bottom: 0,
      top: view.height,
      near: 0.1,
      far: 10,
    },
  });

  let last = 0;
  onFrame((time) => {
    // Steps of 1/60 s when the clock is stopped (the reference images).
    const dt = time > last ? Math.min(time - last, 1 / 30) : 1 / 60;
    last = time;
    bodies
      .clearShapes()
      .addShape({
        shape: { type: 'sphere', radius: disc.radius },
        position: { x: disc.x, y: disc.y, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        center: { x: disc.x, y: disc.y, z: 0 },
        velocity: { ...velocity, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
      })
      .update();
    velocity = { x: 0, y: 0 };
    smoke.update(dt, bodies);
    ball.transform.position = { x: disc.x, y: disc.y, z: -0.5 };
    ball.transform.scale = {
      x: disc.radius * 2,
      y: disc.radius * 2,
      z: disc.radius * 2,
    };
    renderer.render({
      items: [ball, quad],
      camera,
      surface,
      clearColor: { r: 0.02, g: 0.025, b: 0.04, a: 1 },
    });
    info('128 × 192 cells · move the pointer to move the disc');
  });
};

export default example;
