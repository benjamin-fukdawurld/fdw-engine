import {
  Camera,
  ComputeRunner,
  Material,
  Mesh,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import {
  arrayType,
  BuiltinTypes,
  compile,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import { axisAngle } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// The particles, and how long each one lives, in seconds.
const count = 4096;
const life = 1.3;

// A fountain of particles simulated on the GPU, on every backend: WebGL2
// runs the compute graph by rendering to textures. The state of the
// particles is in two pairs of storage buffers, read and written in turn.
const example: Example = ({ backend, surface, onFrame, info }) => {
  // The simulation step: reads the state of the previous frame, writes the
  // next one.
  const c = new GraphBuilder('fountain');
  const index = c.builtin('global-invocation-id').swizzle('x');
  const read = (name: string) =>
    c.call(std.index, {
      array: c.storage(name, arrayType(BuiltinTypes.vec4f)),
      index,
    });
  const state = read('positions');
  const velocity = read('velocities');
  const dt = c.uniform('dt', BuiltinTypes.f32);
  const age = c.call(std.add, { a: state.swizzle('w'), b: dt });
  // At the end of its life, a particle starts again from the origin, at its
  // launch velocity.
  const reborn = c.call(std.greater, { a: age, b: life });
  const nextVelocity = c.call(std.select, {
    ifFalse: c.call(std.add, {
      a: velocity.swizzle('xyz'),
      b: c.call(std.mul, { a: [0, -9.8, 0], b: dt }),
    }),
    ifTrue: read('launches').swizzle('xyz'),
    condition: reborn,
  });
  const nextPosition = c.call(std.select, {
    ifFalse: c.call(std.add, {
      a: state.swizzle('xyz'),
      b: c.call(std.mul, { a: nextVelocity, b: dt }),
    }),
    ifTrue: [0, 0, 0],
    condition: reborn,
  });
  const nextAge = c.call(std.select, {
    ifFalse: age,
    ifTrue: c.call(std.sub, { a: age, b: life }),
    condition: reborn,
  });
  const write = (name: string) =>
    c.storage(name, arrayType(BuiltinTypes.vec4f), { access: 'read-write' });
  c.write(write('nextPositions'), {
    index,
    value: c.call(std.extend, { xyz: nextPosition, w: nextAge }),
  });
  c.write(write('nextVelocities'), {
    index,
    value: c.call(std.extend, { xyz: nextVelocity, w: 0 }),
  });
  c.compute({ workgroupSize: [64, 1, 1] });
  const step = compile(c.build(), { capabilities: backend.capabilities });

  // The initial state: each particle launched upwards, at its own age, so
  // that the fountain flows from the first frame.
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  const launches = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // A golden angle spiral: spread without randomness.
    const angle = i * 2.39996;
    const spread = 0.6 + 0.4 * ((i * 0.618034) % 1);
    const launch = [
      Math.cos(angle) * spread,
      5 + spread,
      Math.sin(angle) * spread,
    ];
    const age = (i / count) * life;
    launches.set(launch, i * 4);
    positions.set(
      [
        launch[0] * age,
        launch[1] * age - 4.9 * age * age,
        launch[2] * age,
        age,
      ],
      i * 4,
    );
    velocities.set([launch[0], launch[1] - 9.8 * age, launch[2]], i * 4);
  }
  const buffer = (data?: Float32Array<ArrayBuffer>) =>
    backend.buffers.create({
      size: count * 16,
      usage: ['storage', 'copy-dst'],
      ...(data ? { initialData: data } : {}),
    });
  // Two states, read and written in turn: a graph cannot read the buffers
  // it writes.
  const states = [
    { positions: buffer(positions), velocities: buffer(velocities) },
    { positions: buffer(), velocities: buffer() },
  ];
  const launchBuffer = buffer(launches);

  // A small quad per particle, moved to the position of its particle: the
  // vertex 4 × i + k is the corner k of the particle i.
  const g = new GraphBuilder('particle');
  const particle = g.call(std.index, {
    array: g.storage('positions', arrayType(BuiltinTypes.vec4f)),
    index: g.call(std.div, { a: g.builtin('vertex-index'), b: 4 }),
  });
  g.surface({
    positionOffset: particle.swizzle('xyz'),
    baseColor: g.call(std.mix, {
      a: [1, 0.85, 0.4],
      b: [0.2, 0.4, 1],
      t: g.call(std.saturate, {
        x: g.call(std.div, { a: particle.swizzle('w'), b: life }),
      }),
    }),
  });
  const material = new Material({ graph: g.build() });

  const corners: number[] = [];
  const indices: number[] = [];
  const size = 0.03;
  for (let i = 0; i < count; i++) {
    corners.push(
      -size,
      -size,
      0,
      size,
      -size,
      0,
      size,
      size,
      0,
      -size,
      size,
      0,
    );
    const a = i * 4;
    indices.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }
  const quads = new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 12,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
          ],
        },
      ],
      vertexCount: count * 4,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [new Float32Array(corners)],
    indices: new Uint16Array(indices),
  });

  const camera = new Camera({
    position: { x: 0, y: 0.6, z: 5 },
    rotation: axisAngle(1, 0, 0, -0.08),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const transform = new Transform();
  const renderer = new Renderer(backend);
  const compute = new ComputeRunner(backend);
  info(
    backend.capabilities?.emulatedCompute
      ? `${count} particles · compute by render to texture`
      : `${count} particles · compute shaders`,
  );

  let current = 0;
  let last = 0;
  onFrame((time) => {
    // At most a tenth of a second per step: a hidden tab resumes smoothly.
    const dt = Math.min(time - last, 0.1);
    last = time;
    const [from, to] = [states[current], states[1 - current]];
    compute.dispatch(step, {
      values: {
        positions: from.positions,
        velocities: from.velocities,
        launches: launchBuffer,
        nextPositions: to.positions,
        nextVelocities: to.velocities,
        dt,
      },
      workgroups: [count / 64],
    });
    // The frame draws the state just written, which the next step reads.
    material.setValue('positions', to.positions);
    current = 1 - current;
    renderer.render({
      items: [{ mesh: quads, material, transform }],
      camera,
      surface,
      clearColor: { r: 0.01, g: 0.01, b: 0.03, a: 1 },
    });
  });
};

export default example;
