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
import { axisAngle, createSphere, followAspect } from '@fdw/demo-scenes';
import type { Example } from './runtime';

type Vec3 = [number, number, number];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));

// A point of the curve with its frame: the tangent t, the normal r and the
// binormal s = t × r, and the length of the curve up to the point.
interface Frame {
  point: Vec3;
  t: Vec3;
  r: Vec3;
  s: Vec3;
  length: number;
}

// Rotation-minimizing frames along the points of a curve, by double
// reflection (Wang, Jüttler, Zheng and Liu, 2008): the frame of a point is
// reflected in the bisecting plane of the chord to the next point, then in
// the plane between the reflected tangent and the next tangent. A closed
// curve gets one more frame, on its first point; the twist between the two
// is spread along the curve.
function frames(points: readonly Vec3[], closed: boolean): Frame[] {
  const n = points.length;
  const at = (i: number) =>
    points[closed ? (i + n) % n : Math.min(Math.max(i, 0), n - 1)];
  const count = closed ? n + 1 : n;
  const result: Frame[] = [];
  for (let i = 0; i < count; i++) {
    const point = at(i);
    const t = normalize(sub(at(i + 1), at(i - 1)));
    let r: Vec3;
    let length = 0;
    if (i === 0) {
      // Any normal to start with.
      const helper: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      r = normalize(cross(helper, t));
    } else {
      const previous = result[i - 1];
      const v1 = sub(point, previous.point);
      const c1 = dot(v1, v1);
      length = previous.length + Math.sqrt(c1);
      const rL = sub(previous.r, scale(v1, (2 / c1) * dot(v1, previous.r)));
      const tL = sub(previous.t, scale(v1, (2 / c1) * dot(v1, previous.t)));
      const v2 = sub(t, tL);
      const c2 = dot(v2, v2);
      r = c2 < 1e-12 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL)));
      // Back to unit and normal to t, against the rounding errors.
      r = normalize(sub(r, scale(t, dot(r, t))));
    }
    result.push({ point, t, r, s: cross(t, r), length });
  }
  if (closed) {
    // The last frame, on the first point, is turned by `twist` around the
    // tangent from the first: each frame turns back by its share.
    const first = result[0];
    const last = result[n];
    const twist = Math.atan2(
      dot(cross(last.r, first.r), first.t),
      dot(last.r, first.r),
    );
    for (const frame of result) {
      const angle = (twist * frame.length) / last.length;
      const r = add(
        scale(frame.r, Math.cos(angle)),
        scale(frame.s, Math.sin(angle)),
      );
      frame.r = r;
      frame.s = cross(frame.t, r);
    }
  }
  return result;
}

// A pipe: a circle of `sides` vertices on each frame, in the plane (r, s),
// plus a disc on each end of an open curve. The uv are the length along
// the curve and the turn around it.
function pipe(
  points: readonly Vec3[],
  {
    radius,
    closed = false,
    sides = 24,
    label,
  }: {
    radius: number;
    closed?: boolean;
    sides?: number;
    label: string;
  },
): Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  const along = frames(points, closed);
  for (const { point, r, s, length } of along) {
    for (let k = 0; k <= sides; k++) {
      const angle = (2 * Math.PI * k) / sides;
      const normal = add(scale(r, Math.cos(angle)), scale(s, Math.sin(angle)));
      vertices.push(...add(point, scale(normal, radius)), ...normal);
      vertices.push(length, k / sides);
    }
  }
  for (let i = 0; i < along.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = i * (sides + 1) + k;
      const b = a + sides + 1;
      // Counterclockwise seen from outside.
      indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }
  if (!closed) {
    for (const [frame, side] of [
      [along[0], -1],
      [along[along.length - 1], 1],
    ] as const) {
      const normal = scale(frame.t, side);
      const center = vertices.length / 8;
      vertices.push(...frame.point, ...normal, 0.5, 0.5);
      for (let k = 0; k <= sides; k++) {
        const angle = (2 * Math.PI * k) / sides;
        const out = add(
          scale(frame.r, Math.cos(angle)),
          scale(frame.s, Math.sin(angle)),
        );
        vertices.push(...add(frame.point, scale(out, radius)), ...normal);
        vertices.push(0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle));
        if (k < sides) {
          // The circle turns counterclockwise around +t.
          indices.push(
            ...(side > 0
              ? [center, center + 1 + k, center + 2 + k]
              : [center, center + 2 + k, center + 1 + k]),
          );
        }
      }
    }
  }
  const count = vertices.length / 8;
  return new Mesh({
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
      vertexCount: count,
      indexBuffer: {
        format: count > 0xffff ? 'uint32' : 'uint16',
        count: indices.length,
      },
    },
    vertices: [new Float32Array(vertices)],
    indices:
      count > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices),
  });
}

// A uniform Catmull-Rom spline through points: `steps` points per segment,
// the ends extended by symmetry.
function catmullRom(points: readonly Vec3[], steps: number): Vec3[] {
  const n = points.length;
  const at = (i: number): Vec3 =>
    i < 0
      ? sub(scale(points[0], 2), points[1])
      : i >= n
        ? sub(scale(points[n - 1], 2), points[n - 2])
        : points[i];
  const result: Vec3[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push(
        [0, 1, 2].map(
          (c) =>
            0.5 *
            (2 * p1[c] +
              (p2[c] - p0[c]) * t +
              (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
              (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t3),
        ) as Vec3,
      );
    }
  }
  result.push(points[n - 1]);
  return result;
}

// Pipes swept along curves of space: a trefoil knot, closed, and a spline
// through points, open, with its ends closed by discs. Stripes along the
// pipes and rings every 25 cm show their frames: they do not twist.
const example: Example = ({ backend, surface, onFrame }) => {
  // The trefoil knot, 400 points.
  const knotPoints: Vec3[] = [];
  for (let i = 0; i < 400; i++) {
    const a = (2 * Math.PI * i) / 400;
    knotPoints.push(
      scale(
        [
          Math.sin(a) + 2 * Math.sin(2 * a),
          Math.cos(a) - 2 * Math.cos(2 * a),
          -Math.sin(3 * a),
        ],
        0.42,
      ),
    );
  }
  const knot = pipe(knotPoints, { radius: 0.22, closed: true, label: 'knot' });

  // A spline through six points, with straight parts and turns.
  const controls: Vec3[] = [
    [-2.2, -0.6, -1.4],
    [-1.6, 0.9, -0.2],
    [-0.4, 0.2, 1.2],
    [0.8, 1.4, 0.6],
    [1.4, -0.2, -0.6],
    [2.4, 0.6, -1.6],
  ];
  const spline = pipe(catmullRom(controls, 32), {
    radius: 0.16,
    label: 'spline',
  });

  // Two colors in stripes along the pipe, lines on the rings and between
  // the stripes.
  const g = new GraphBuilder('striped pipe');
  const uv = g.attribute('uv', BuiltinTypes.vec2f);
  const cells = g.call(std.mul, { a: uv, b: [4, 4] });
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
  const stripe = g.call(std.step, {
    edge: 0.5,
    x: g.call(std.fract, { x: g.call(std.mul, { a: uv.swizzle('y'), b: 2 }) }),
  });
  const color = g.call(std.mix, {
    a: g.uniform('color', BuiltinTypes.vec3f),
    b: g.uniform('stripeColor', BuiltinTypes.vec3f),
    t: g.call(std.vec3, { x: stripe, y: stripe, z: stripe }),
  });
  g.surface({
    shadingModel: 'pbr',
    baseColor: g.call(std.mix, {
      a: color,
      b: [0.05, 0.05, 0.06],
      t: g.call(std.vec3, { x: line, y: line, z: line }),
    }),
    metallic: 0.2,
    roughness: 0.4,
  });
  const graph = g.build();

  const knotTransform = new Transform({ position: { x: -2.4, y: 1.2, z: 0 } });
  const splineTransform = new Transform({ position: { x: 2, y: 1, z: 0 } });
  const marker = new Material({
    graph,
    values: { color: [0.9, 0.85, 0.3], stripeColor: [0.9, 0.85, 0.3] },
  });
  const sphere = createSphere(16, 8);
  const items: RenderItem[] = [
    {
      mesh: knot,
      material: new Material({
        graph,
        values: { color: [0.85, 0.3, 0.15], stripeColor: [0.95, 0.85, 0.7] },
      }),
      transform: knotTransform,
    },
    {
      mesh: spline,
      material: new Material({
        graph,
        values: { color: [0.15, 0.45, 0.85], stripeColor: [0.8, 0.9, 0.95] },
      }),
      transform: splineTransform,
    },
    // The points the spline goes through.
    ...controls.map((p) => ({
      mesh: sphere,
      material: marker,
      transform: new Transform({
        position: {
          x: p[0] + splineTransform.position.x,
          y: p[1] + splineTransform.position.y,
          z: p[2] + splineTransform.position.z,
        },
        scale: { x: 0.45, y: 0.45, z: 0.45 },
      }),
    })),
  ];

  const camera = new Camera({
    position: { x: 0, y: 2.6, z: 8.2 },
    rotation: axisAngle(1, 0, 0, -0.2),
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({
    direction: { x: -0.5, y: -0.8, z: -0.6 },
    ambient: { x: 0.25, y: 0.26, z: 0.3 },
    diffuse: { x: 1.2, y: 1.15, z: 1.1 },
    specular: { x: 0.6, y: 0.6, z: 0.6 },
  });
  const renderer = new Renderer(backend, {
    output: { toneMapping: 'neutral', encoding: 'srgb' },
  });

  onFrame((time) => {
    // The knot turns on itself.
    knotTransform.rotation = axisAngle(0.3, 1, 0.2, time * 0.4);
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
