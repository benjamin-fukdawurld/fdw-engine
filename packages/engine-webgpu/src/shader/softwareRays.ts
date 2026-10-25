// The traversal of the software acceleration structures (see
// SoftwareTopLevel), added to the WGSL programs that trace rays: the top
// level, then the bottom level of each instance met, in the space of the
// instance. Each level keeps a stack of the nodes left to visit; both
// children of a node are tested at once, the nearest visited first, the
// leaves tested as soon as met. The triangles by Möller-Trumbore, on both
// faces. The result is that of the ray-query instruction of the IR.

/** The identifiers of the buffers of an acceleration structure binding. */
export interface AccelerationStructureBuffers {
  readonly top: string;
  // The nodes and the triangles of the bottom levels: vec4 offsets.
  readonly bottom: string;
}

/** The name of the function tracing rays against a binding. */
export const traceFunctionName = (binding: string): string =>
  `fdw_trace_${binding}`;

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
): string {
  const p = `fdw_${binding}`;
  return `// The rays of "${binding}": a BVH traversed in software.
const ${p}_far = 3.0e38;

// Where a ray enters a box within [tMin, tMax], or ${p}_far.
fn ${p}_box(low: vec3<f32>, high: vec3<f32>, origin: vec3<f32>, inverse: vec3<f32>, tMin: f32, tMax: f32) -> f32 {
  let t0 = (low - origin) * inverse;
  let t1 = (high - origin) * inverse;
  let near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), tMin));
  let far = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), tMax));
  return select(${p}_far, near, near <= far);
}

// 1 / direction, away from the infinities of the zero components.
fn ${p}_inverse(direction: vec3<f32>) -> vec3<f32> {
  let tiny = vec3<f32>(1e-20);
  let safe = select(direction, select(-tiny, tiny, direction >= vec3<f32>(0.0)), abs(direction) < tiny);
  return 1.0 / safe;
}

// Tests the count triangles from the vec4 first of the pool: a closer hit
// updates tBest and best. Returns whether one was found.
fn ${p}_triangles(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, first: u32, count: u32, instance: u32, tBest: ptr<function, f32>, best: ptr<function, vec4<u32>>) -> bool {
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
    if (u >= 0.0 && u <= 1.0 && v >= 0.0 && u + v <= 1.0 && t > tMin && t < *tBest) {
      *tBest = t;
      let back = select(0x80000000u, 0u, det > 0.0);
      *best = vec4<u32>(instance, bitcast<u32>(v0.w) | back, bitcast<u32>(u), bitcast<u32>(v));
      found = true;
    }
  }
  return found;
}

// The bottom level of an instance, from its root (reference, count).
// Returns true to stop: a hit found with anyHit.
fn ${p}_bottom(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, root: vec2<u32>, instance: u32, anyHit: bool, tBest: ptr<function, f32>, best: ptr<function, vec4<u32>>) -> bool {
  if (root.y > 0u) {
    return ${p}_triangles(origin, direction, tMin, root.x, root.y, instance, tBest, best) && anyHit;
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
      if (${p}_triangles(origin, direction, tMin, bitcast<u32>(a0.w), leftCount, instance, tBest, best) && anyHit) {
        return true;
      }
      tLeft = ${p}_far;
    }
    if (tRight < ${p}_far && rightCount > 0u) {
      if (${p}_triangles(origin, direction, tMin, bitcast<u32>(b0.w), rightCount, instance, tBest, best) && anyHit) {
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
    if (${p}_bottom(localOrigin, localDirection, tMin, info.xy, info.w, anyHit, tBest, best)) {
      return true;
    }
  }
  return false;
}

fn ${traceFunctionName(binding)}(origin: vec3<f32>, direction: vec3<f32>, tMin: f32, tMax: f32, mask: u32, anyHit: bool) -> vec4<u32> {
  var best = vec4<u32>(0xffffffffu, 0u, 0u, 0u);
  var tBest = tMax;
  let header = bitcast<vec4<u32>>(${top}[0]);
  if (header.w == 0u) {
    return best;
  }
  if (header.y > 0u) {
    ${p}_instances(origin, direction, tMin, mask, anyHit, header.z, header.x, header.y, &tBest, &best);
    return best;
  }
  let inverse = ${p}_inverse(direction);
  var stack: array<u32, ${StackSize}>;
  var size = 0u;
  var node = header.x;
  loop {
    let at = 1u + node * 4u;
    let a0 = ${top}[at];
    let a1 = ${top}[at + 1u];
    let b0 = ${top}[at + 2u];
    let b1 = ${top}[at + 3u];
    var tLeft = ${p}_box(a0.xyz, a1.xyz, origin, inverse, tMin, tBest);
    var tRight = ${p}_box(b0.xyz, b1.xyz, origin, inverse, tMin, tBest);
    let leftCount = bitcast<u32>(a1.w);
    let rightCount = bitcast<u32>(b1.w);
    if (tLeft < ${p}_far && leftCount > 0u) {
      if (${p}_instances(origin, direction, tMin, mask, anyHit, header.z, bitcast<u32>(a0.w), leftCount, &tBest, &best)) {
        return best;
      }
      tLeft = ${p}_far;
    }
    if (tRight < ${p}_far && rightCount > 0u) {
      if (${p}_instances(origin, direction, tMin, mask, anyHit, header.z, bitcast<u32>(b0.w), rightCount, &tBest, &best)) {
        return best;
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
  return best;
}`;
}
