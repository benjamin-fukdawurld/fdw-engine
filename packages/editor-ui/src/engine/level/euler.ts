// The rotations of the inspector: Euler angles in degrees, intrinsic X,
// then Y, then Z (the rotation Rx·Ry·Rz, the order XYZ of three.js), to
// and from the quaternions of the transforms.

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

const toRadians = Math.PI / 180;

export function quatFromEuler([x, y, z]: Vec3): [
  number,
  number,
  number,
  number,
] {
  const [c1, c2, c3] = [x, y, z].map((a) => Math.cos((a * toRadians) / 2));
  const [s1, s2, s3] = [x, y, z].map((a) => Math.sin((a * toRadians) / 2));
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function eulerFromQuat([x, y, z, w]: Quat): [number, number, number] {
  // The terms of the rotation matrix that the angles come from.
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  // Not asin(m13): precise near ±90° too, with the floats of the pool.
  const ey = Math.atan2(m13, Math.hypot(m11, m12));
  // At ±90° around Y, X and Z turn around the same axis: Z is 0.
  const [ex, ez] =
    Math.abs(m13) < 0.9999999
      ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)]
      : [Math.atan2(m32, m22), 0];
  // No -0 in the fields of the inspector.
  return [ex, ey, ez].map((a) => a / toRadians + 0) as [number, number, number];
}
