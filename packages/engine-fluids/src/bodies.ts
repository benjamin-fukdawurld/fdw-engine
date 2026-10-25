import type {
  GpuBuffer,
  IQuat,
  IVec3,
  RenderBackend,
} from '@fdw/engine-backend';
import { Ops } from '@fdw/engine-ocean';
import { writeData } from './buffers';
import type { PhysicsBody } from '@fdw/engine-physics';
import { arrayType, BuiltinTypes } from '@fdw/engine-shader';
import type { GraphBuilder, PortHandle } from '@fdw/engine-shader';

/** The shapes a body has for the fluids: a sphere, or a box (half extents). */
export type FluidShape =
  | { readonly type: 'sphere'; readonly radius: number }
  | { readonly type: 'box'; readonly halfExtents: IVec3 };

/** A body as the fluids see it: a shape posed in the world, and how it moves. */
export interface FluidBody {
  readonly shape: FluidShape;
  /** The center of the shape, in the world. */
  readonly position: IVec3;
  readonly rotation: IQuat;
  /** The center of mass of the body the shape is part of. */
  readonly center: IVec3;
  readonly velocity: IVec3;
  readonly angularVelocity: IVec3;
}

/** The vec4 of a body in the buffer of {@link FluidBodies}. */
export const BodyStride = 6;

/** The bodies in a buffer at most: the loops of the graphs go over them all. */
export const MaxBodies = 64;

/**
 * Writes bodies into the layout the graphs read: for each one, six vec4 —
 * the center of the shape and its kind (0 sphere, 1 box), its rotation
 * (from the shape to the world), its size (the radius, or the half
 * extents), the velocity, the angular velocity, the center of mass.
 */
export function packBodies(
  bodies: readonly FluidBody[],
  out = new Float32Array(Math.max(bodies.length, 1) * BodyStride * 4),
): Float32Array {
  bodies.forEach((body, i) => {
    const o = i * BodyStride * 4;
    const { shape, position: p, rotation: q } = body;
    const size =
      shape.type === 'sphere'
        ? [shape.radius, shape.radius, shape.radius]
        : [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z];
    out.set([p.x, p.y, p.z, shape.type === 'sphere' ? 0 : 1], o);
    out.set([q.x, q.y, q.z, q.w], o + 4);
    out.set([...size, 0], o + 8);
    out.set([body.velocity.x, body.velocity.y, body.velocity.z, 0], o + 12);
    const w = body.angularVelocity;
    out.set([w.x, w.y, w.z, 0], o + 16);
    out.set([body.center.x, body.center.y, body.center.z, 0], o + 20);
  });
  return out;
}

/** What {@link FluidBodies.add} takes from a body. */
export interface FluidBodyOptions {
  /**
   * The shape the fluids see, around the center of mass of the body: by
   * default, its sphere and box colliders (each where it is), and the
   * bounds of the others.
   */
  readonly shape?: FluidShape;
}

/**
 * The bodies of the physics that the fluids feel: their shapes (spheres,
 * boxes), where they are and how they move, in a storage buffer that the
 * compute graphs of the fluids read. {@link FluidBodies.update} once a
 * frame, before the fluids step: the shallow water rises around what sinks
 * into it, the smoke flows around the obstacles, the particles are pushed
 * away.
 *
 * @example
 * ```ts
 * const bodies = new FluidBodies(backend);
 * bodies.add(crate); // its box collider
 * // Each frame:
 * bodies.update();
 * water.step(dt, bodies);
 * ```
 */
export class FluidBodies {
  /** The six vec4 of each body (see {@link packBodies}). */
  readonly buffer: GpuBuffer;
  private readonly _entries = new Map<
    PhysicsBody,
    { readonly shapes: readonly ShapeSource[] }
  >();
  private readonly _extra: FluidBody[] = [];
  private _current: FluidBody[] = [];
  private readonly _data = new Float32Array(MaxBodies * BodyStride * 4);

  constructor(backend: RenderBackend) {
    this.buffer = backend.buffers.create({
      label: 'fluid bodies',
      size: this._data.byteLength,
      usage: ['storage', 'copy-dst'],
    });
  }

  /** The bodies of the last update, as the graphs see them. */
  get bodies(): readonly FluidBody[] {
    return this._current;
  }

  /** The number of shapes of the last update. */
  get count(): number {
    return this._current.length;
  }

  /** Lets the fluids feel a body of the physics. */
  add(body: PhysicsBody, options: FluidBodyOptions = {}): this {
    const shapes: ShapeSource[] = [];
    if (options.shape) {
      shapes.push({ shape: options.shape });
    } else {
      for (const collider of body.colliders) {
        if (collider.sensor) {
          continue;
        }
        const shape = fluidShapeOf(collider.shape);
        if (shape) {
          shapes.push({ shape, collider });
        }
      }
    }
    if (shapes.length === 0) {
      throw new Error('The body has no shape the fluids can feel');
    }
    this._entries.set(body, { shapes });
    return this;
  }

  remove(body: PhysicsBody): this {
    this._entries.delete(body);
    return this;
  }

  /**
   * A shape moved by the application (a stirring stick, an obstacle
   * dragged by the mouse), not by the physics: kept until
   * {@link FluidBodies.clearShapes}.
   */
  addShape(body: FluidBody): this {
    this._extra.push(body);
    return this;
  }

  clearShapes(): this {
    this._extra.length = 0;
    return this;
  }

  /**
   * Reads the poses and velocities of the bodies and writes the buffer.
   * The bodies removed from their world are forgotten.
   */
  update(): this {
    const current: FluidBody[] = [];
    const pose = new Float32Array(7);
    const alive = new Map<PhysicsBody['world'], Set<PhysicsBody>>();
    for (const [body, entry] of this._entries) {
      let bodies = alive.get(body.world);
      if (!bodies) {
        bodies = new Set(body.world.bodies);
        alive.set(body.world, bodies);
      }
      if (!bodies.has(body)) {
        this._entries.delete(body);
        continue;
      }
      const center = copy(body.position);
      for (const { shape, collider } of entry.shapes) {
        let position = center;
        let rotation: IQuat = copyQuat(body.rotation);
        if (collider) {
          collider.readPose(pose);
          position = { x: pose[0], y: pose[1], z: pose[2] };
          rotation = { x: pose[3], y: pose[4], z: pose[5], w: pose[6] };
        }
        current.push({
          shape,
          position,
          rotation,
          center,
          velocity: copy(body.linearVelocity),
          angularVelocity: copy(body.angularVelocity),
        });
      }
    }
    current.push(...this._extra);
    if (current.length > MaxBodies) {
      throw new Error(
        `The fluids feel ${MaxBodies} shapes at most: ${current.length}`,
      );
    }
    this._current = current;
    if (current.length > 0) {
      packBodies(current, this._data);
      writeData(
        this.buffer,
        this._data.subarray(0, current.length * BodyStride * 4),
      );
    }
    return this;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

interface ShapeSource {
  readonly shape: FluidShape;
  readonly collider?: PhysicsBody['colliders'][number];
}

// The shape of a collider for the fluids: its own for spheres and boxes,
// the bounds of the others.
function fluidShapeOf(
  shape: PhysicsBody['colliders'][number]['shape'],
): FluidShape | undefined {
  switch (shape.type) {
    case 'sphere':
      return { type: 'sphere', radius: shape.radius };
    case 'box':
      return { type: 'box', halfExtents: copy(shape.halfExtents) };
    case 'capsule':
      return {
        type: 'box',
        halfExtents: {
          x: shape.radius,
          y: shape.halfHeight + shape.radius,
          z: shape.radius,
        },
      };
    case 'cylinder':
      return {
        type: 'box',
        halfExtents: { x: shape.radius, y: shape.halfHeight, z: shape.radius },
      };
    case 'convex': {
      // The bounds of the points, around the origin of the collider.
      const half = { x: 0, y: 0, z: 0 };
      const p = shape.points;
      for (let i = 0; i < p.length; i += 3) {
        half.x = Math.max(half.x, Math.abs(p[i]));
        half.y = Math.max(half.y, Math.abs(p[i + 1]));
        half.z = Math.max(half.z, Math.abs(p[i + 2]));
      }
      return { type: 'box', halfExtents: half };
    }
    default:
      // Meshes and heightfields are static ground: the fluids have their own.
      return undefined;
  }
}

const copy = ({ x, y, z }: IVec3): IVec3 => ({ x, y, z });
const copyQuat = ({ x, y, z, w }: IQuat): IQuat => ({ x, y, z, w });

// --- On the CPU: the same functions as the graphs, for the steps of the CPU
// and the tests.

/** v turned by the inverse of the unit quaternion q. */
export function rotateInverse(q: IQuat, v: IVec3): IVec3 {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

/** v turned by the unit quaternion q. */
export function rotate(q: IQuat, v: IVec3): IVec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Where a point is from a body: the signed distance, the outward normal. */
export interface BodyContact {
  readonly distance: number;
  readonly normal: IVec3;
  /** The velocity of the surface of the body at the point: v + ω × r. */
  readonly velocity: IVec3;
}

/** The signed distance from a body to a point of the world, and its normal. */
export function bodyContact(body: FluidBody, point: IVec3): BodyContact {
  const local = rotateInverse(body.rotation, {
    x: point.x - body.position.x,
    y: point.y - body.position.y,
    z: point.z - body.position.z,
  });
  let distance: number;
  let normal: IVec3;
  if (body.shape.type === 'sphere') {
    const length = Math.hypot(local.x, local.y, local.z);
    distance = length - body.shape.radius;
    normal =
      length > 0
        ? { x: local.x / length, y: local.y / length, z: local.z / length }
        : { x: 0, y: 1, z: 0 };
  } else {
    const h = body.shape.halfExtents;
    const q = [
      Math.abs(local.x) - h.x,
      Math.abs(local.y) - h.y,
      Math.abs(local.z) - h.z,
    ];
    const s = [
      Math.sign(local.x) || 1,
      Math.sign(local.y) || 1,
      Math.sign(local.z) || 1,
    ];
    const outside = q.map((v) => Math.max(v, 0));
    const outer = Math.hypot(outside[0], outside[1], outside[2]);
    const inner = Math.min(Math.max(q[0], q[1], q[2]), 0);
    distance = outer + inner;
    if (outer > 0) {
      normal = {
        x: (outside[0] * s[0]) / outer,
        y: (outside[1] * s[1]) / outer,
        z: (outside[2] * s[2]) / outer,
      };
    } else {
      // Inside: out through the nearest face.
      const axis = q[0] >= q[1] && q[0] >= q[2] ? 0 : q[1] >= q[2] ? 1 : 2;
      normal = {
        x: axis === 0 ? s[0] : 0,
        y: axis === 1 ? s[1] : 0,
        z: axis === 2 ? s[2] : 0,
      };
    }
  }
  const r = {
    x: point.x - body.center.x,
    y: point.y - body.center.y,
    z: point.z - body.center.z,
  };
  const v = body.velocity;
  const w = body.angularVelocity;
  return {
    distance,
    normal: rotate(body.rotation, normal),
    velocity: {
      x: v.x + w.y * r.z - w.z * r.y,
      y: v.y + w.z * r.x - w.x * r.z,
      z: v.z + w.x * r.y - w.y * r.x,
    },
  };
}

/**
 * The span of a body along the vertical line through (x, z): its lowest
 * and highest points there, or undefined if the line misses it.
 */
export function bodySpan(
  body: FluidBody,
  x: number,
  z: number,
): { low: number; high: number } | undefined {
  const c = body.position;
  if (body.shape.type === 'sphere') {
    const r = body.shape.radius;
    const d2 = (x - c.x) ** 2 + (z - c.z) ** 2;
    if (d2 >= r * r) {
      return undefined;
    }
    const half = Math.sqrt(r * r - d2);
    return { low: c.y - half, high: c.y + half };
  }
  // The line p(t) = (x, t, z) in the frame of the box: origin + t × up.
  const origin = rotateInverse(body.rotation, {
    x: x - c.x,
    y: -c.y,
    z: z - c.z,
  });
  const up = rotateInverse(body.rotation, { x: 0, y: 1, z: 0 });
  const h = body.shape.halfExtents;
  let low = -Infinity;
  let high = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = nonZero(up[axis]);
    const t1 = (-h[axis] - origin[axis]) / d;
    const t2 = (h[axis] - origin[axis]) / d;
    low = Math.max(low, Math.min(t1, t2));
    high = Math.min(high, Math.max(t1, t2));
  }
  return low < high ? { low, high } : undefined;
}

// Away from 0, keeping its sign: a line parallel to a face of a box.
const nonZero = (d: number) => d + (d < 0 ? -1e-7 : 1e-7);

// --- In the graphs.

const vec4Array = arrayType(BuiltinTypes.vec4f);

/** The reads of the bodies in a graph: their buffer and their count. */
export interface BodiesInGraph {
  readonly buffer: PortHandle;
  readonly count: PortHandle;
}

/**
 * Declares the bodies in a graph: the `bodies` storage buffer and the
 * `bodyCount` uniform (set from a {@link FluidBodies}).
 */
export function bodiesInGraph(g: GraphBuilder): BodiesInGraph {
  return {
    buffer: g.storage('bodies', vec4Array),
    count: g.uniform('bodyCount', BuiltinTypes.u32, { default: 0 }),
  };
}

/** The six vec4 of the body `index` (a u32). */
export function readBody(o: Ops, bodies: BodiesInGraph, index: PortHandle) {
  const base = o.mul(index, BodyStride);
  const at = (k: number) => o.index(bodies.buffer, o.add(base, k));
  return {
    position: at(0).swizzle('xyz'),
    kind: at(0).swizzle('w'),
    rotation: at(1),
    size: at(2).swizzle('xyz'),
    velocity: at(3).swizzle('xyz'),
    angularVelocity: at(4).swizzle('xyz'),
    center: at(5).swizzle('xyz'),
  };
}

/** v turned by the unit quaternion q (a vec4), in a graph. */
export function rotateInGraph(
  o: Ops,
  q: PortHandle,
  v: PortHandle,
): PortHandle {
  const axis = q.swizzle('xyz');
  const t = o.mul(o.cross(axis, v), 2);
  return o.add(o.add(v, o.mul(t, q.swizzle('w'))), o.cross(axis, t));
}

/** v turned by the inverse of the unit quaternion q (a vec4), in a graph. */
export function rotateInverseInGraph(
  o: Ops,
  q: PortHandle,
  v: PortHandle,
): PortHandle {
  return rotateInGraph(o, o.mul(q, [-1, -1, -1, 1]), v);
}

// The sign of each component, 1 for 0.
const signs = (o: Ops, v: PortHandle) =>
  o.sub(o.mul(o.step([0, 0, 0], v), 2), 1);

/**
 * The signed distance from the body to a point (vec4: the outward normal
 * in xyz, the distance in w), in a graph.
 */
export function bodyDistanceInGraph(
  o: Ops,
  body: ReturnType<typeof readBody>,
  point: PortHandle,
): PortHandle {
  const local = rotateInverseInGraph(
    o,
    body.rotation,
    o.sub(point, body.position),
  );
  // The sphere.
  const length = o.length(local);
  const sphereNormal = o.div(local, o.max(length, 1e-6));
  const sphereDistance = o.sub(length, body.size.swizzle('x'));
  // The box.
  const q = o.sub(o.abs(local), body.size);
  const s = signs(o, local);
  const outside = o.max(q, [0, 0, 0]);
  const outer = o.length(outside);
  const largest = o.max(q.swizzle('x'), o.max(q.swizzle('y'), q.swizzle('z')));
  const inner = o.min(largest, 0);
  const isX = o.greaterEqual(
    q.swizzle('x'),
    o.max(q.swizzle('y'), q.swizzle('z')),
  );
  const isY = o.greaterEqual(q.swizzle('y'), q.swizzle('z'));
  const face = o.select(o.select([0, 0, 1], [0, 1, 0], isY), [1, 0, 0], isX);
  const boxNormal = o.select(
    o.mul(face, s),
    o.div(o.mul(outside, s), o.max(outer, 1e-6)),
    o.greater(outer, 0),
  );
  const boxDistance = o.add(outer, inner);
  const isBox = o.greater(body.kind, 0.5);
  const normal = rotateInGraph(
    o,
    body.rotation,
    o.select(sphereNormal, boxNormal, isBox),
  );
  return o.extend(normal, o.select(sphereDistance, boxDistance, isBox));
}

/** The velocity of the surface of a body at a point: v + ω × r, in a graph. */
export function bodyVelocityInGraph(
  o: Ops,
  body: ReturnType<typeof readBody>,
  point: PortHandle,
): PortHandle {
  return o.add(
    body.velocity,
    o.cross(body.angularVelocity, o.sub(point, body.center)),
  );
}

/**
 * The span of a body along the vertical line through `xz` (vec2: the
 * lowest and highest heights; low ≥ high when the line misses it), in a
 * graph.
 */
export function bodySpanInGraph(
  o: Ops,
  body: ReturnType<typeof readBody>,
  xz: PortHandle,
): PortHandle {
  const c = body.position;
  // The sphere.
  const r = body.size.swizzle('x');
  const d = o.sub(xz, c.swizzle('xz'));
  const d2 = o.dot(d, d);
  const half = o.sqrt(o.max(o.sub(o.mul(r, r), d2), 0));
  const sphere = o.select(
    o.vec2(1, 0),
    o.vec2(o.sub(c.swizzle('y'), half), o.add(c.swizzle('y'), half)),
    o.less(d2, o.mul(r, r)),
  );
  // The box: the line origin + t × up in its frame, between its slabs.
  const origin = rotateInverseInGraph(
    o,
    body.rotation,
    o.vec3(
      o.sub(xz.swizzle('x'), c.swizzle('x')),
      o.mul(c.swizzle('y'), -1),
      o.sub(xz.swizzle('y'), c.swizzle('z')),
    ),
  );
  const up = rotateInverseInGraph(o, body.rotation, o.vec3(0, 1, 0));
  // Away from 0, keeping its sign.
  const direction = o.add(up, o.mul(signs(o, up), 1e-7));
  const t1 = o.div(o.sub(o.mul(body.size, -1), origin), direction);
  const t2 = o.div(o.sub(body.size, origin), direction);
  const near = o.min(t1, t2);
  const far = o.max(t1, t2);
  const box = o.vec2(
    o.max(near.swizzle('x'), o.max(near.swizzle('y'), near.swizzle('z'))),
    o.min(far.swizzle('x'), o.min(far.swizzle('y'), far.swizzle('z'))),
  );
  return o.select(sphere, box, o.greater(body.kind, 0.5));
}
