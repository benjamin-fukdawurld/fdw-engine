import { cross, dot, ReadonlyVec3, scale, set, sub, Vec3, vec3 } from '../math';
import type { ConvexVolume } from './Volume';

// GJK (Gilbert, Johnson, Keerthi): two convex volumes intersect when their
// Minkowski difference contains the origin. It is searched with a simplex
// (a point, a segment, a triangle, then a tetrahedron) of points of the
// difference, each one given by the support functions of the volumes.

const MaxIterations = 64;
const Epsilon = 1e-12;

const supportA = vec3();
const supportB = vec3();
const negated = vec3();

// A point of the Minkowski difference: the farthest of a along d minus the
// farthest of b along -d.
function minkowski(
  a: ConvexVolume,
  b: ConvexVolume,
  d: ReadonlyVec3,
  out: Vec3,
): Vec3 {
  a.support(d, supportA);
  b.support(scale(negated, d, -1), supportB);
  return sub(out, supportA, supportB);
}

// Triple cross product (a × b) × c.
function tripleCross(out: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = cross(vec3(), a, b);
  return cross(out, ab, c);
}

const ao = vec3();
const ab = vec3();
const ac = vec3();
const abc = vec3();
const edgeNormal = vec3();

/**
 * Updates the simplex (the newest point last) to its part nearest to the
 * origin, and the direction to search next. True when the simplex contains
 * the origin.
 */
function nearestSimplex(simplex: Vec3[], d: Vec3): boolean {
  switch (simplex.length) {
    case 2:
      return line(simplex, d);
    case 3:
      return triangle(simplex, d);
    default:
      return tetrahedron(simplex, d);
  }
}

function line(simplex: Vec3[], d: Vec3): boolean {
  const [b, a] = simplex;
  sub(ab, b, a);
  scale(ao, a, -1);
  if (dot(ab, ao) > 0) {
    tripleCross(d, ab, ao, ab);
    // The origin on the segment.
    return dot(d, d) < Epsilon;
  }
  simplex.length = 0;
  simplex.push(a);
  set(d, ao[0], ao[1], ao[2]);
  return false;
}

function triangle(simplex: Vec3[], d: Vec3): boolean {
  const [c, b, a] = simplex;
  sub(ab, b, a);
  sub(ac, c, a);
  scale(ao, a, -1);
  cross(abc, ab, ac);
  if (dot(cross(edgeNormal, abc, ac), ao) > 0) {
    // Beyond the edge AC.
    if (dot(ac, ao) > 0) {
      simplex.length = 0;
      simplex.push(c, a);
      tripleCross(d, ac, ao, ac);
      return dot(d, d) < Epsilon;
    }
    simplex.length = 0;
    simplex.push(b, a);
    return line(simplex, d);
  }
  if (dot(cross(edgeNormal, ab, abc), ao) > 0) {
    // Beyond the edge AB.
    simplex.length = 0;
    simplex.push(b, a);
    return line(simplex, d);
  }
  // Above or below the triangle.
  const side = dot(abc, ao);
  if (Math.abs(side) < Epsilon) {
    return true;
  }
  simplex.length = 0;
  if (side > 0) {
    simplex.push(c, b, a);
    set(d, abc[0], abc[1], abc[2]);
  } else {
    simplex.push(b, c, a);
    set(d, -abc[0], -abc[1], -abc[2]);
  }
  return false;
}

const faceNormal = vec3();
const toOpposite = vec3();
const edge1 = vec3();
const edge2 = vec3();

function tetrahedron(simplex: Vec3[], d: Vec3): boolean {
  const [p0, p1, p2, a] = simplex;
  scale(ao, a, -1);
  // The three faces through the newest point, each with the vertex opposite.
  const faces: [Vec3, Vec3, Vec3][] = [
    [p2, p1, p0],
    [p1, p0, p2],
    [p0, p2, p1],
  ];
  for (const [x, y, opposite] of faces) {
    sub(edge1, x, a);
    sub(edge2, y, a);
    cross(faceNormal, edge1, edge2);
    // Facing away from the tetrahedron.
    if (dot(faceNormal, sub(toOpposite, opposite, a)) > 0) {
      scale(faceNormal, faceNormal, -1);
    }
    if (dot(faceNormal, ao) > Epsilon) {
      simplex.length = 0;
      simplex.push(y, x, a);
      return triangle(simplex, d);
    }
  }
  return true;
}

/**
 * Whether two convex volumes intersect, from their support functions only.
 * Volumes that only touch can be reported either way.
 */
export function gjkIntersects(a: ConvexVolume, b: ConvexVolume): boolean {
  const d = vec3(1, 0, 0);
  const first = minkowski(a, b, d, vec3());
  if (dot(first, first) < Epsilon) {
    return true;
  }
  const simplex: Vec3[] = [first];
  scale(d, first, -1);
  for (let i = 0; i < MaxIterations; i++) {
    const point = minkowski(a, b, d, vec3());
    if (dot(point, d) < 0) {
      // The farthest point along d does not pass the origin.
      return false;
    }
    simplex.push(point);
    if (nearestSimplex(simplex, d)) {
      return true;
    }
  }
  // No progress: the origin is on the boundary of the difference.
  return true;
}
