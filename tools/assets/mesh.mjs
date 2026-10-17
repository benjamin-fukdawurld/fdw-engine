// Mesh operations of the asset tools, on primitives in plain arrays:
// `{ attributes: { POSITION, NORMAL, TEXCOORD_0, ... }, indices, material }`,
// each attribute a typed array, the indices a Uint32Array.
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;

export const triangleCount = (primitive) => primitive.indices.length / 3;

/** A random generator in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * The islands of a primitive: groups of triangles connected by shared
 * vertices. Returns the island of each triangle and their number.
 */
export function islands(primitive) {
  const { indices } = primitive;
  const vertexCount = primitive.attributes.POSITION.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    parent[find(indices[t + 1])] = a;
    parent[find(indices[t + 2])] = a;
  }
  const ids = new Map();
  const of = new Uint32Array(indices.length / 3);
  for (let t = 0; t < of.length; t++) {
    const root = find(indices[t * 3]);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    of[t] = id;
  }
  return { of, count: ids.size };
}

/** The primitive with only the vertices its indices use, in their order. */
export function compact(primitive) {
  const { indices, attributes } = primitive;
  const vertexCount = attributes.POSITION.length / 3;
  const remap = new Int32Array(vertexCount).fill(-1);
  let count = 0;
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    let v = remap[indices[i]];
    if (v < 0) v = remap[indices[i]] = count++;
    out[i] = v;
  }
  const compacted = {};
  for (const [name, array] of Object.entries(attributes)) {
    const size = array.length / vertexCount;
    const target = new array.constructor(count * size);
    for (let v = 0; v < vertexCount; v++) {
      const to = remap[v];
      if (to >= 0) {
        for (let c = 0; c < size; c++)
          target[to * size + c] = array[v * size + c];
      }
    }
    compacted[name] = target;
  }
  return { ...primitive, attributes: compacted, indices: out };
}

/**
 * Keeps a fraction of the islands (cards of needles, blades of grass),
 * each grown around its center by `fraction^-exponent`, capped at
 * `maxScale`, so that fewer cards cover about the same area. The choice
 * comes from a fixed value per island: a smaller fraction keeps a subset
 * of what a larger one keeps (the levels of detail nest).
 */
export function thin(
  primitive,
  fraction,
  { seed = 1, exponent = 0.5, maxScale = 8 } = {},
) {
  if (fraction >= 1) return primitive;
  const { of, count } = islands(primitive);
  const random = seededRandom(seed);
  const value = new Float32Array(count);
  for (let i = 0; i < count; i++) value[i] = random();
  const scale = Math.min(maxScale, Math.pow(fraction, -exponent));

  const { indices } = primitive;
  const positions = primitive.attributes.POSITION;
  // The centers of the islands kept.
  const center = new Float64Array(count * 4);
  for (let t = 0; t < of.length; t++) {
    const island = of[t];
    if (value[island] >= fraction) continue;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      center[island * 4] += positions[v * 3];
      center[island * 4 + 1] += positions[v * 3 + 1];
      center[island * 4 + 2] += positions[v * 3 + 2];
      center[island * 4 + 3] += 1;
    }
  }
  const kept = [];
  const islandOfVertex = new Int32Array(positions.length / 3).fill(-1);
  for (let t = 0; t < of.length; t++) {
    const island = of[t];
    if (value[island] >= fraction) continue;
    for (let k = 0; k < 3; k++) {
      kept.push(indices[t * 3 + k]);
      islandOfVertex[indices[t * 3 + k]] = island;
    }
  }
  const grown = new Float32Array(positions);
  for (let v = 0; v < islandOfVertex.length; v++) {
    const island = islandOfVertex[v];
    if (island < 0) continue;
    const n = center[island * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const middle = center[island * 4 + c] / n;
      grown[v * 3 + c] = middle + (positions[v * 3 + c] - middle) * scale;
    }
  }
  return compact({
    ...primitive,
    attributes: { ...primitive.attributes, POSITION: grown },
    indices: Uint32Array.from(kept),
  });
}

/**
 * Simplifies a primitive towards `targetTriangles` by edge collapses that
 * keep the normals and the texture coordinates (meshopt), within
 * `maxError` (relative to the size of the mesh).
 */
export function simplify(primitive, targetTriangles, { maxError = 0.05 } = {}) {
  if (targetTriangles >= triangleCount(primitive)) return primitive;
  const positions = primitive.attributes.POSITION;
  const vertexCount = positions.length / 3;
  const normals = primitive.attributes.NORMAL;
  const uvs = primitive.attributes.TEXCOORD_0;
  const stride = (normals ? 3 : 0) + (uvs ? 2 : 0);
  const extra = new Float32Array(vertexCount * Math.max(stride, 1));
  for (let v = 0; v < vertexCount; v++) {
    let o = v * stride;
    if (normals) {
      extra[o++] = normals[v * 3];
      extra[o++] = normals[v * 3 + 1];
      extra[o++] = normals[v * 3 + 2];
    }
    if (uvs) {
      extra[o++] = uvs[v * 2];
      extra[o++] = uvs[v * 2 + 1];
    }
  }
  const weights = [...(normals ? [0.5, 0.5, 0.5] : []), ...(uvs ? [1, 1] : [])];
  const [indices] = stride
    ? MeshoptSimplifier.simplifyWithAttributes(
        primitive.indices,
        positions,
        3,
        extra,
        stride,
        weights,
        null,
        targetTriangles * 3,
        maxError,
        [],
      )
    : MeshoptSimplifier.simplify(
        primitive.indices,
        positions,
        3,
        targetTriangles * 3,
        maxError,
      );
  return compact({ ...primitive, indices });
}

/** Multiplies the positions (and moves them): `p * scale + offset`. */
export function transformPositions(primitive, scale, offset = [0, 0, 0]) {
  const positions = new Float32Array(primitive.attributes.POSITION);
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++)
      positions[i + c] = positions[i + c] * scale + offset[c];
  }
  return {
    ...primitive,
    attributes: { ...primitive.attributes, POSITION: positions },
  };
}
