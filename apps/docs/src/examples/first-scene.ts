import {
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { Example } from './runtime';

// A lit cube turning in front of the camera.
const example: Example = ({ backend, surface, onFrame }) => {
  // The material: a graph describing the surface, lit by the Phong model.
  const g = new GraphBuilder('orange');
  g.surface({
    shadingModel: 'phong',
    baseColor: g.uniform('color', BuiltinTypes.vec3f, {
      default: [1, 0.45, 0.1],
    }),
  });
  const material = new Material({ graph: g.build() });

  // The mesh: positions and normals, interleaved, one face after another.
  const faces = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  faces.forEach(([normal, u, v], face) => {
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      for (let axis = 0; axis < 3; axis++) {
        vertices.push(0.5 * (normal[axis] + su * u[axis] + sv * v[axis]));
      }
      vertices.push(...normal);
    }
    const first = face * 4;
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  });
  const cube = new Mesh({
    description: {
      vertexBuffers: [
        {
          stride: 24,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
          ],
        },
      ],
      vertexCount: 24,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [new Float32Array(vertices)],
    indices: new Uint16Array(indices),
  });

  const transform = new Transform();
  const camera = new Camera({
    position: { x: 0, y: 0, z: 3 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({ direction: { x: -1, y: -1, z: -1 } });
  const renderer = new Renderer(backend);

  onFrame((time) => {
    // A quaternion turning around the diagonal axis.
    const half = time / 2;
    const s = Math.sin(half) / Math.SQRT2;
    transform.rotation = { x: s, y: s, z: 0, w: Math.cos(half) };
    renderer.render({
      items: [{ mesh: cube, material, transform }],
      camera,
      surface,
      lights: [sun],
      clearColor: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
    });
  });
};

export default example;
