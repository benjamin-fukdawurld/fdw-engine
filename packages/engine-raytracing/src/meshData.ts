import { hasAttribute, Mesh, readAttribute } from '@fdw/engine-core';
import { RayVertexVec4s } from '@fdw/engine-shader';

/** What the rays need of a mesh: its triangles and its vertices. */
export interface RayMeshData {
  /** xyz per vertex: what the acceleration structure is built from. */
  readonly positions: Float32Array<ArrayBuffer>;
  /** 3 per triangle. */
  readonly indices: Uint32Array<ArrayBuffer>;
  /**
   * RayVertexVec4s vec4 per vertex (see RayInstanceVec4s of
   * @fdw/engine-shader): the position and u, the normal and v, the tangent.
   */
  readonly vertices: Float32Array<ArrayBuffer>;
}

/**
 * The triangles and vertices of a mesh, for the rays; undefined for the
 * meshes rays cannot hit (lines, points, strips, without positions or
 * triangles). A mesh without normals gets those of its triangles,
 * averaged; without tangents, (1, 0, 0, 1).
 */
export function rayMeshData(mesh: Mesh): RayMeshData | undefined {
  const { topology = 'triangle-list', vertexCount } = mesh.description;
  if (topology !== 'triangle-list' || vertexCount === 0) {
    return undefined;
  }
  const positions = readAttribute(mesh, 'position', 3);
  if (!positions) {
    return undefined;
  }
  const source = mesh.indices;
  const indices = source
    ? Uint32Array.from(source)
    : Uint32Array.from(
        { length: vertexCount - (vertexCount % 3) },
        (_, i) => i,
      );
  if (indices.length < 3) {
    return undefined;
  }
  const normals = hasAttribute(mesh, 'normal')
    ? (readAttribute(mesh, 'normal', 3) as Float32Array)
    : triangleNormals(positions, indices);
  const uvs = readAttribute(mesh, 'uv', 2);
  const tangents = readAttribute(mesh, 'tangent', 4);
  const vertices = new Float32Array(vertexCount * RayVertexVec4s * 4);
  for (let v = 0; v < vertexCount; v++) {
    const o = v * RayVertexVec4s * 4;
    vertices[o] = positions[v * 3];
    vertices[o + 1] = positions[v * 3 + 1];
    vertices[o + 2] = positions[v * 3 + 2];
    vertices[o + 3] = uvs ? uvs[v * 2] : 0;
    vertices[o + 4] = normals[v * 3];
    vertices[o + 5] = normals[v * 3 + 1];
    vertices[o + 6] = normals[v * 3 + 2];
    vertices[o + 7] = uvs ? uvs[v * 2 + 1] : 0;
    if (tangents) {
      vertices.set(tangents.subarray(v * 4, v * 4 + 4), o + 8);
    } else {
      vertices[o + 8] = 1;
      vertices[o + 11] = 1;
    }
  }
  return { positions, indices, vertices };
}

// The normals of the vertices: the normals of their triangles, weighted by
// their areas, normalized.
function triangleNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const e1 = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]);
    const e2 = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const vertex of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        normals[vertex + k] += n[k];
      }
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const length = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    for (let k = 0; k < 3; k++) {
      normals[v + k] /= length;
    }
  }
  return normals;
}
