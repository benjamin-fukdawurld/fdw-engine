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

// The vertices of a grid along each side.
const side = 96;

// Ripples computed on the GPU: a compute graph writes the height of each
// vertex of a grid into a storage buffer, which its material reads. On
// every backend: WebGL2 runs the graph by rendering to a texture.
const example: Example = ({ backend, surface, onFrame }) => {
  // The compute graph: one thread per vertex, in workgroups of 8 × 8.
  const c = new GraphBuilder('ripples');
  const id = c.builtin('global-invocation-id');
  const point = c.call(
    std.convert,
    { value: id.swizzle('xy') },
    { params: { to: BuiltinTypes.vec2f } },
  );
  const distance = c.call(std.length, {
    x: c.call(std.sub, { a: point, b: (side - 1) / 2 }),
  });
  const wave = c.call(std.sin, {
    x: c.call(std.sub, {
      a: c.call(std.mul, { a: distance, b: 0.35 }),
      b: c.call(std.mul, { a: c.uniform('time', BuiltinTypes.f32), b: 3 }),
    }),
  });
  const heights = c.storage('heights', arrayType(BuiltinTypes.f32), {
    access: 'read-write',
  });
  c.write(heights, {
    index: c.call(std.add, {
      a: c.call(std.mul, { a: id.swizzle('y'), b: side }),
      b: id.swizzle('x'),
    }),
    value: c.call(std.mul, { a: wave, b: 0.08 }),
  });
  c.compute({ workgroupSize: [8, 8, 1] });
  const ripples = compile(c.build(), { capabilities: backend.capabilities });

  const buffer = backend.buffers.create({
    size: side * side * 4,
    usage: ['storage'],
  });

  // The material reads the height of its vertex in the same buffer.
  const g = new GraphBuilder('water');
  const height = g.call(std.index, {
    array: g.storage('heights', arrayType(BuiltinTypes.f32)),
    index: g.builtin('vertex-index'),
  });
  g.surface({
    positionOffset: g.call(std.vec3, { y: height }),
    baseColor: g.call(std.mix, {
      a: [0.02, 0.15, 0.35],
      b: [0.5, 0.85, 1],
      t: g.call(std.saturate, {
        x: g.call(std.add, { a: g.call(std.mul, { a: height, b: 6 }), b: 0.5 }),
      }),
    }),
  });
  const material = new Material({
    graph: g.build(),
    values: { heights: buffer },
  });

  // A flat grid of side × side vertices, 4 units wide.
  const positions: number[] = [];
  const indices: number[] = [];
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      positions.push((x / (side - 1)) * 4 - 2, 0, (z / (side - 1)) * 4 - 2);
      if (x < side - 1 && z < side - 1) {
        const a = z * side + x;
        indices.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
      }
    }
  }
  const grid = new Mesh({
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
      vertexCount: side * side,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [new Float32Array(positions)],
    indices: new Uint16Array(indices),
  });

  const camera = new Camera({
    position: { x: 0, y: 2.6, z: 3.6 },
    rotation: axisAngle(1, 0, 0, -0.6),
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

  onFrame((time) => {
    // Submitted before the frame: the GPU runs them in that order.
    compute.dispatch(ripples, {
      values: { heights: buffer, time },
      workgroups: [side / 8, side / 8],
    });
    transform.rotation = axisAngle(0, 1, 0, time * 0.1);
    renderer.render({
      items: [{ mesh: grid, material, transform }],
      camera,
      surface,
      clearColor: { r: 0.01, g: 0.02, b: 0.04, a: 1 },
    });
  });
};

export default example;
