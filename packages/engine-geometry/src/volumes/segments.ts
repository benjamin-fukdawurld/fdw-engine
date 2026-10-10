import { dot, ReadonlyVec3, scaleAndAdd, sub, Vec3, vec3 } from '../math';

const ab = vec3();
const ap = vec3();
const d1 = vec3();
const d2 = vec3();
const r = vec3();
const p1 = vec3();
const p2 = vec3();
const between = vec3();

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** The point of the segment [a, b] closest to p, written into `out`. */
export function closestOnSegment(
  out: Vec3,
  p: ReadonlyVec3,
  a: ReadonlyVec3,
  b: ReadonlyVec3
): Vec3 {
  sub(ab, b, a);
  sub(ap, p, a);
  const length2 = dot(ab, ab);
  const t = length2 > 0 ? clamp01(dot(ap, ab) / length2) : 0;
  return scaleAndAdd(out, a, ab, t);
}

/**
 * The squared distance between the segments [a0, a1] and [b0, b1]
 * (Ericson, Real-Time Collision Detection, 5.1.9).
 */
export function segmentDistanceSquared(
  a0: ReadonlyVec3,
  a1: ReadonlyVec3,
  b0: ReadonlyVec3,
  b1: ReadonlyVec3
): number {
  sub(d1, a1, a0);
  sub(d2, b1, b0);
  sub(r, a0, b0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denominator = a * e - b * b;
      s = denominator !== 0 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  scaleAndAdd(p1, a0, d1, s);
  scaleAndAdd(p2, b0, d2, t);
  sub(between, p1, p2);
  return dot(between, between);
}
