import {
  RayAlphaMaskSize,
  RayInstanceFlags,
  RayInstanceVec4s,
} from '@fdw/engine-shader';

// The traversal of the software acceleration structures (see
// SoftwareTopLevel), added to the WGSL programs that trace rays: the top
// level, then the bottom level of each instance met, in the space of the
// instance. Each level keeps a stack of the nodes left to visit; both
// children of a node are tested at once, the nearest visited first. In the
// bottom levels, the leaves are tested as soon as met; the top level visits
// its leaves as entries of its stack, its instances (and their traversal)
// in one place of the code: inlined three times, the traversals of the
// shaders tracing several rays (the soft shadows) took minutes to compile
// on SwiftShader. The triangles by Möller-Trumbore, on both faces. The
// result is that of the ray-query instruction of the IR.
//
// The variant of the rays traced with alphaTest (ray.traceAlpha) keeps the
// candidate triangles of the instances that are not opaque (bit 8 of the
// mask of their record) only where the alpha mask of their material lets
// them be (RayInstanceFlags.alphaTest): the uv of the candidate point from
// the rayGeometry buffer, the bit of the mask nearest to it.

/** The identifiers of the buffers of an acceleration structure binding. */
export interface AccelerationStructureBuffers {
  readonly top: string;
  // The nodes and the triangles of the bottom levels: vec4 offsets.
  readonly bottom: string;
}

/** The name of the function tracing rays against a binding. */
export const traceFunctionName = (binding: string, alphaTest = false): string =>
  `fdw_trace_${alphaTest ? 'alpha_' : ''}${binding}`;

/** The buffers of the scene read by the alpha test (ray.traceAlpha). */
export interface AlphaTestBuffers {
  readonly instances: string;
  readonly geometry: string;
}

// Deep enough for the BVHs of the SAH: a push past it is dropped.
const StackSize = 48;

/**
 * The WGSL functions tracing rays against an acceleration structure, whose
 * buffers have the given identifiers: `fdw_trace_<binding>(origin,
 * direction, tMin, tMax, mask, anyHit) -> vec4<u32>`.
 */
export function softwareRayFunctions(
  binding: string,
  { top, bottom }: AccelerationStructureBuffers,
  alpha?: AlphaTestBuffers,
): string {
  const p = `fdw_${binding}${alpha ? '_alpha' : ''}`;
  // The test of a candidate triangle of an instance that is not opaque.
  const alphaTest = alpha
    ? `
      if (!opaque && !${p}_kept(instance, bitcast<u32>(v0.w), u, v)) {
        continue;
      }`
    : '';
  const alphaFunction = alpha
    ? `
// Whether the point (u, v) of the triangle of the mesh of an instance is in
// the alpha mask of its material (RayAlphaMaskSize): kept where no mask.
fn ${p}_kept(instance: u32, triangle: u32, u: f32, v: f32) -> bool {
  let info = bitcast<vec4<u32>>(${alpha.instances}[instance * ${RayInstanceVec4s}u + 6u]);
  if ((info.w & ${RayInstanceFlags.alphaTest}u) == 0u) {
    return true;
  }
  let corners = bitcast<vec3<u32>>(${alpha.geometry}[info.x + triangle].xyz);
  let w = vec3<f32>(1.0 - u - v, u, v);
  let s = dot(w, vec3<f32>(${alpha.geometry}[corners.x].w, ${alpha.geometry}[corners.y].w, ${alpha.geometry}[corners.z].w));
  let t = dot(w, vec3<f32>(${alpha.geometry}[corners.x + 1u].w, ${alpha.geometry}[corners.y + 1u].w, ${alpha.geometry}[corners.z + 1u].w));
  let texel = min(vec2<u32>(fract(vec2<f32>(s, t)) * ${RayAlphaMaskSize}.0), vec2<u32>(${RayAlphaMaskSize - 1}u));
  let bit = texel.y * ${RayAlphaMaskSize}u + texel.x;
  let word = bitcast<vec4<u32>>(${alpha.geometry}[(info.w >> 8u) + bit / 128u]);
  return ((word[(bit / 32u) % 4u] >> (bit % 32u)) & 1u) != 0u;
}
`
    : '';
  return `// The rays of "${binding}"${
    alpha ? ', through the alpha masks' : ''
  }: a BVH traversed in software.
const ${p}_far = 3.0e38;
${alphaFunction}
// Where a ray enters a box within [tMin, tMax], or ${p}_far.
fn ${p}_box(low: vec3<f32>, high: vec3<f32>, origin: vec3<f32>, inverse: vec3<f32>, tMin: f32, tMax: f32) -> f32 {
  let t0 = (low - origin) * inverse;
  let t1 = (high - origin) * inverse;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), tMin));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
  return select(${p}_far, near, near <= far);
}

// Whether a vector has no infinity nor NaN (by its bits: the comparisons
// with NaN differ between the GPUs). A ray that has would enter every box
// where min and max drop the NaN.
fn ${p}_finite(v: vec3<f32>) -> bool {
  let exponents = bitcast<vec3<u32>>(v) & vec3<u32>(0x7f800000u);
  return all(exponents != vec3<u32>(0x7f800000u));
}

// 1 / direction, away from the infinities of the zero components.
fn ${p}_inverse(direction: vec3<f32>) -> vec3<f32> {
  let tiny = vec3<f32>(1e-20);
  let safe = select(direction, select(-tiny, tiny, direction >= vec3<f32>(0.0)), abs(direction) < tiny);
  return 1.0 / safe;
}

// Tests the count triangles from the vec4 first of the pool: a closer hit
// updates tBest and best. Returns whether one was found.
fn ${p}_triangles(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, first: u32, count: u32, instance: u32, opaque: bool, tBest: ptr<function, f32>, best: ptr<function, vec4<u32>>) -> bool {
  var found = false;
  for (var i = first; i < first + count * 3u; i = i + 3u) {
    let v0 = ${bottom}[i];
    let e1 = ${bottom}[i + 1u].xyz;
    let e2 = ${bottom}[i + 2u].xyz;
    let p = cross(direction, e2);
    let det = dot(e1, p);
    if (det == 0.0) {
      continue;
    }
    let inverse = 1.0 / det;
    let s = origin - v0.xyz;
    let u = dot(s, p) * inverse;
    let q = cross(s, e1);
    let v = dot(direction, q) * inverse;
    let t = dot(e2, q) * inverse;
    if (u >= 0.0 && u <= 1.0 && v >= 0.0 && u + v <= 1.0 && t > tMin && t < *tBest) {${alphaTest}
      *tBest = t;
      let back = select(0x80000000u, 0u, det > 0.0);
      *best = vec4<u32>(instance, bitcast<u32>(v0.w) | back, bitcast<u32>(u), bitcast<u32>(v));
      found = true;
    }
  }
  return found;
}

// The children of a node hit by a ray, nearest first: the next entry to
// visit (a node, or a leaf: reference and count, see BvhRef), the other one
// pushed on the stack; or none (count 0xffffffff).
fn ${p}_children(a0: vec4<f32>, a1: vec4<f32>, b0: vec4<f32>, b1: vec4<f32>, origin: vec3<f32>, inverse: vec3<f32>, tMin: f32, tBest: f32, stack: ptr<function, array<vec2<u32>, ${StackSize}>>, size: ptr<function, u32>) -> vec2<u32> {
  let tLeft = ${p}_box(a0.xyz, a1.xyz, origin, inverse, tMin, tBest);
  let tRight = ${p}_box(b0.xyz, b1.xyz, origin, inverse, tMin, tBest);
  let left = vec2<u32>(bitcast<u32>(a0.w), bitcast<u32>(a1.w));
  let right = vec2<u32>(bitcast<u32>(b0.w), bitcast<u32>(b1.w));
  if (tLeft < ${p}_far && tRight < ${p}_far) {
    let leftFirst = tLeft <= tRight;
    if (*size < ${StackSize}u) {
      (*stack)[*size] = select(left, right, leftFirst);
      *size = *size + 1u;
    }
    return select(right, left, leftFirst);
  }
  if (tLeft < ${p}_far) {
    return left;
  }
  if (tRight < ${p}_far) {
    return right;
  }
  return vec2<u32>(0u, 0xffffffffu);
}

// The bottom level of an instance, from its root (reference, count): the
// leaves tested as soon as met (the triangles in three places; the top
// level visits its instances in one, see below). Returns true to stop: a
// hit found with anyHit.
fn ${p}_bottom(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, root: vec2<u32>, instance: u32, opaque: bool, anyHit: bool, tBest: ptr<function, f32>, best: ptr<function, vec4<u32>>) -> bool {
  if (root.y > 0u) {
    return ${p}_triangles(origin, direction, tMin, root.x, root.y, instance, opaque, tBest, best) && anyHit;
  }
  let inverse = ${p}_inverse(direction);
  var stack: array<u32, ${StackSize}>;
  var size = 0u;
  var node = root.x;
  loop {
    let a0 = ${bottom}[node];
    let a1 = ${bottom}[node + 1u];
    let b0 = ${bottom}[node + 2u];
    let b1 = ${bottom}[node + 3u];
    var tLeft = ${p}_box(a0.xyz, a1.xyz, origin, inverse, tMin, *tBest);
    var tRight = ${p}_box(b0.xyz, b1.xyz, origin, inverse, tMin, *tBest);
    let leftCount = bitcast<u32>(a1.w);
    let rightCount = bitcast<u32>(b1.w);
    if (tLeft < ${p}_far && leftCount > 0u) {
      if (${p}_triangles(origin, direction, tMin, bitcast<u32>(a0.w), leftCount, instance, opaque, tBest, best) && anyHit) {
        return true;
      }
      tLeft = ${p}_far;
    }
    if (tRight < ${p}_far && rightCount > 0u) {
      if (${p}_triangles(origin, direction, tMin, bitcast<u32>(b0.w), rightCount, instance, opaque, tBest, best) && anyHit) {
        return true;
      }
      tRight = ${p}_far;
    }
    if (tLeft < ${p}_far && tRight < ${p}_far) {
      let leftFirst = tLeft <= tRight;
      if (size < ${StackSize}u) {
        stack[size] = select(bitcast<u32>(a0.w), bitcast<u32>(b0.w), leftFirst);
        size = size + 1u;
      }
      node = select(bitcast<u32>(b0.w), bitcast<u32>(a0.w), leftFirst);
    } else if (tLeft < ${p}_far) {
      node = bitcast<u32>(a0.w);
    } else if (tRight < ${p}_far) {
      node = bitcast<u32>(b0.w);
    } else if (size > 0u) {
      size = size - 1u;
      node = stack[size];
    } else {
      break;
    }
  }
  return false;
}

// The instances [first, first + count) of the top level, each in its
// space. Returns true to stop.
fn ${p}_instances(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, mask: u32, anyHit: bool, base: u32, first: u32, count: u32, tBest: ptr<function, f32>, best: ptr<function, vec4<u32>>) -> bool {
  for (var k = first; k < first + count; k = k + 1u) {
    let at = base + k * 4u;
    let info = bitcast<vec4<u32>>(${top}[at + 3u]);
    if ((info.z & mask) == 0u) {
      continue;
    }
    let r0 = ${top}[at];
    let r1 = ${top}[at + 1u];
    let r2 = ${top}[at + 2u];
    let o = vec4<f32>(origin, 1.0);
    let d = vec4<f32>(direction, 0.0);
    let localOrigin = vec3<f32>(dot(r0, o), dot(r1, o), dot(r2, o));
    let localDirection = vec3<f32>(dot(r0, d), dot(r1, d), dot(r2, d));
    if (${p}_bottom(localOrigin, localDirection, tMin, info.xy, info.w, (info.z & 0x100u) == 0u, anyHit, tBest, best)) {
      return true;
    }
  }
  return false;
}

// The top level as the bottom ones: the instances of its leaves visited in
// one place.
fn ${traceFunctionName(binding, alpha !== undefined)}(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, tMax: f32, mask: u32, anyHit: bool) -> vec4<u32> {
  var best = vec4<u32>(0xffffffffu, 0u, 0u, 0u);
  var tBest = tMax;
  let header = bitcast<vec4<u32>>(${top}[0]);
  if (header.w == 0u || !${p}_finite(origin) || !${p}_finite(direction)) {
    return best;
  }
  let inverse = ${p}_inverse(direction);
  var stack: array<vec2<u32>, ${StackSize}>;
  var size = 0u;
  var entry = header.xy;
  loop {
    if (entry.y != 0xffffffffu) {
      if (entry.y > 0u) {
        if (${p}_instances(origin, direction, tMin, mask, anyHit, header.z, entry.x, entry.y, &tBest, &best)) {
          return best;
        }
      } else {
        let at = 1u + entry.x * 4u;
        entry = ${p}_children(${top}[at], ${top}[at + 1u], ${top}[at + 2u], ${top}[at + 3u], origin, inverse, tMin, tBest, &stack, &size);
        continue;
      }
    }
    if (size == 0u) {
      break;
    }
    size = size - 1u;
    entry = stack[size];
  }
  return best;
}`;
}
