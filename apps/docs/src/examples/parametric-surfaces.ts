import {
  Camera,
  DirectionalLight,
  Material,
  Mesh,
  Renderer,
  Transform,
  type RenderItem,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { axisAngle, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

type Vec3 = [number, number, number];
// A parametric surface: a point of space for (u, v) in [0, 1]².
type ParametricSurface = (u: number, v: number) => Vec3;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));

// The step of the central differences.
const h = 1e-4;

// The vertices of a surface on a grid of (columns + 1) × (rows + 1)
// points: the position, the normal (the cross product of the two partial
// derivatives) and (u, v). Then the same again, normals reversed: the back
// side of an open surface.
function sample(
  surface: ParametricSurface,
  columns: number,
  rows: number,
): Float32Array<ArrayBuffer> {
  const count = (columns + 1) * (rows + 1);
  const data = new Float32Array(count * 2 * 8);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      const u = i / columns;
      const v = j / rows;
      const p = surface(u, v);
      const du = sub(
        surface(Math.min(u + h, 1), v),
        surface(Math.max(u - h, 0), v),
      );
      const dv = sub(
        surface(u, Math.min(v + h, 1)),
        surface(u, Math.max(v - h, 0)),
      );
      const n = normalize(cross(du, dv));
      const k = j * (columns + 1) + i;
      data.set([...p, ...n, u, v], k * 8);
      data.set([...p, -n[0], -n[1], -n[2], u, v], (count + k) * 8);
    }
  }
  return data;
}

// A mesh sampling a surface, sampled again by update when it changes.
function surfaceMesh(
  surface: ParametricSurface,
  columns: number,
  rows: number,
  label: string,
): { mesh: Mesh; update(surface: ParametricSurface): void } {
  const count = (columns + 1) * (rows + 1);
  const indices: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i;
      const b = a + 1;
      const c = a + columns + 2;
      const d = a + columns + 1;
      // Counterclockwise around du × dv, then the back side clockwise.
      indices.push(a, b, c, a, c, d);
      indices.push(
        count + a,
        count + c,
        count + b,
        count + a,
        count + d,
        count + c,
      );
    }
  }
  const mesh = new Mesh({
    label,
    description: {
      vertexBuffers: [
        {
          stride: 32,
          stepMode: 'vertex',
          attributes: [
            { semantic: 'position', format: 'float32x3', offset: 0 },
            { semantic: 'normal', format: 'float32x3', offset: 12 },
            { semantic: 'uv', format: 'float32x2', offset: 24 },
          ],
        },
      ],
      vertexCount: count * 2,
      indexBuffer: { format: 'uint16', count: indices.length },
    },
    vertices: [sample(surface, columns, rows)],
    indices: new Uint16Array(indices),
  });
  return {
    mesh,
    update: (changed) => mesh.setVertices(0, sample(changed, columns, rows)),
  };
}

// A thin tube around a curve drawn in a plane of normal p: in the plane,
// the normal of the curve is p × T; around the curve, a circle in the two.
const tube =
  (curve: (u: number) => Vec3, p: Vec3, radius = 0.04): ParametricSurface =>
  (u, v) => {
    const tangent = sub(curve(Math.min(u + h, 1)), curve(Math.max(u - h, 0)));
    const normal = normalize(cross(p, tangent));
    const angle = 2 * Math.PI * v;
    return add(
      curve(u),
      add(
        scale(normal, radius * Math.cos(angle)),
        scale(p, radius * Math.sin(angle)),
      ),
    );
  };

// Two surfaces made of two curves in orthogonal planes. On the left, a
// translation surface: the curve A swept along the curve B. On the right, a
// spherical product: a meridian in the plane XY turned along a section in
// the plane XZ. The curves change with time; the surfaces are sampled again.
const example: Example = ({ backend, surface, onFrame }) => {
  // --- The translation surface: A in the plane z = 1.5, B in the plane
  // x = -1.5, both from the corner O = A(0) = B(0).
  let amplitude = 0.45;
  const A = (u: number): Vec3 => [
    -1.5 + 3 * u,
    amplitude * Math.sin(3 * Math.PI * u),
    1.5,
  ];
  const B = (v: number): Vec3 => [
    -1.5,
    0.9 * Math.sin(Math.PI * v),
    1.5 - 3 * v,
  ];
  const O = A(0);
  const translation: ParametricSurface = (u, v) => sub(add(A(u), B(v)), O);

  // --- The spherical product: the meridian (r(u), y(u)) in the plane XY,
  // the section (x(v), z(v)) in the plane XZ, a superellipse of exponent n:
  // a circle for n = 2, a square as n grows.
  const radius = (u: number) => 0.65 + 0.35 * Math.cos(1.8 * Math.PI * u);
  const height = (u: number) => 2.4 * u;
  let n = 2;
  const section = (v: number): [number, number] => {
    const c = Math.cos(2 * Math.PI * v);
    const s = Math.sin(2 * Math.PI * v);
    return [
      Math.sign(c) * Math.abs(c) ** (2 / n),
      Math.sign(s) * Math.abs(s) ** (2 / n),
    ];
  };
  const product: ParametricSurface = (u, v) => {
    const [x, z] = section(v);
    return [radius(u) * x, height(u), radius(u) * z];
  };

  // The meshes: the two surfaces, their four curves.
  const sheet = surfaceMesh(translation, 64, 64, 'translation surface');
  const vase = surfaceMesh(product, 48, 96, 'spherical product');
  const curveA = surfaceMesh(tube(A, [0, 0, 1]), 128, 8, 'curve A');
  const curveB = surfaceMesh(tube(B, [1, 0, 0]), 128, 8, 'curve B');
  const meridian = surfaceMesh(
    tube((u) => [radius(u), height(u), 0], [0, 0, 1]),
    128,
    8,
    'meridian',
  );
  const sectionCurve = surfaceMesh(
    tube(
      (v) => {
        const [x, z] = section(v);
        return [x, 0, z];
      },
      [0, 1, 0],
    ),
    192,
    8,
    'section',
  );

  // Lines on the iso-curves of u and v, a pixel wide at any distance.
  const g = new GraphBuilder('lined surface');
  const cells = g.call(std.mul, {
    a: g.attribute('uv', BuiltinTypes.vec2f),
    b: g.uniform('cells', BuiltinTypes.vec2f, { default: [16, 16] }),
  });
  const fraction = g.call(std.fract, { x: cells });
  const pixels = g.call(std.div, {
    a: g.call(std.min, {
      a: fraction,
      b: g.call(std.sub, { a: [1, 1], b: fraction }),
    }),
    b: g.call(std.fwidth, { x: cells }),
  });
  const line = g.call(std.sub, {
    a: 1,
    b: g.call(std.saturate, {
      x: g.call(std.min, { a: pixels.swizzle('x'), b: pixels.swizzle('y') }),
    }),
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: g.uniform('color', BuiltinTypes.vec3f),
      b: g.uniform('lineColor', BuiltinTypes.vec3f),
      t: g.call(std.vec3, { x: line, y: line, z: line }),
    }),
    metallic: 0,
    roughness: 0.55,
  });
  const graph = g.build();
  const lined = (color: number[], lineColor = color, cells = [16, 16]) =>
    new Material({ graph, values: { color, lineColor, cells } });
  const red = lined([0.85, 0.2, 0.12]);
  const blue = lined([0.1, 0.35, 0.9]);

  const left = new Transform({ position: { x: -2.1, y: 0, z: 0 } });
  const right = new Transform({ position: { x: 2.1, y: 0, z: 0 } });
  const items: RenderItem[] = [
    {
      mesh: sheet.mesh,
      material: lined([0.82, 0.8, 0.75], [0.25, 0.25, 0.28]),
      transform: left,
    },
    { mesh: curveA.mesh, material: red, transform: left },
    { mesh: curveB.mesh, material: blue, transform: left },
    {
      mesh: vase.mesh,
      material: lined([0.82, 0.8, 0.75], [0.25, 0.25, 0.28], [12, 16]),
      transform: right,
    },
    { mesh: meridian.mesh, material: red, transform: right },
    { mesh: sectionCurve.mesh, material: blue, transform: right },
  ];

  const camera = new Camera({
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({
    direction: { x: -0.4, y: -1, z: -0.6 },
    ambient: { x: 0.25, y: 0.26, z: 0.3 },
    diffuse: { x: 1.2, y: 1.15, z: 1.1 },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  onFrame((time) => {
    // The curves change: the wave of A breathes, the section goes from the
    // circle to the square. The surfaces follow.
    amplitude = 0.45 * Math.cos(time * 0.5);
    n = 2 + 3 * (0.5 - 0.5 * Math.cos(time * 0.7));
    sheet.update(translation);
    curveA.update(tube(A, [0, 0, 1]));
    vase.update(product);
    sectionCurve.update(
      tube(
        (v) => {
          const [x, z] = section(v);
          return [x, 0, z];
        },
        [0, 1, 0],
      ),
    );

    // The camera swings around the two surfaces, looking down at them.
    const yaw = 0.45 * Math.sin(time * 0.25);
    const pitch = -0.42;
    const distance = 8.5;
    camera.position = {
      x: distance * Math.cos(pitch) * Math.sin(yaw),
      y: 0.9 - distance * Math.sin(pitch),
      z: distance * Math.cos(pitch) * Math.cos(yaw),
    };
    const turn = axisAngle(0, 1, 0, yaw);
    const tilt = axisAngle(1, 0, 0, pitch);
    camera.rotation = {
      x: turn.w * tilt.x + turn.x * tilt.w + turn.y * tilt.z - turn.z * tilt.y,
      y: turn.w * tilt.y - turn.x * tilt.z + turn.y * tilt.w + turn.z * tilt.x,
      z: turn.w * tilt.z + turn.x * tilt.y - turn.y * tilt.x + turn.z * tilt.w,
      w: turn.w * tilt.w - turn.x * tilt.x - turn.y * tilt.y - turn.z * tilt.z,
    };
    followAspect(camera, surface);
    renderer.render({
      items,
      lights: [sun],
      camera,
      surface,
      clearColor: { r: 0.06, g: 0.07, b: 0.09, a: 1 },
    });
  });
};

export default example;
