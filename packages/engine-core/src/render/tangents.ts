import { Mesh } from './Mesh';

// Reads a float32 attribute of a mesh, by semantic: its buffer, offset and
// stride, or undefined when the mesh has none.
function attributeReader(
  mesh: Mesh,
  semantic: string,
  format: 'float32x2' | 'float32x3',
): ((vertex: number, component: number) => number) | undefined {
  for (const [buffer, layout] of mesh.description.vertexBuffers.entries()) {
    const attribute = layout.attributes.find(
      (candidate) => candidate.semantic === semantic,
    );
    if (!attribute) {
      continue;
    }
    if (attribute.format !== format) {
      throw new Error(
        `computeTangents: the ${semantic} attribute must be ${format}, not ${attribute.format}`,
      );
    }
    const data = mesh.vertices[buffer];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return (vertex, component) =>
      view.getFloat32(
        vertex * layout.stride + attribute.offset + component * 4,
        true,
      );
  }
  return undefined;
}

/**
 * A copy of a mesh with tangents: a vertex buffer more, holding the
 * `tangent` attribute (float32x4) of each vertex, for the normal mapping of
 * the materials (`macro.normalMapping`, `macro.parallaxMapping`…).
 *
 * xyz is the direction of increasing u on the surface, perpendicular to
 * the normal; w (±1) gives the bitangent, `cross(normal, xyz) × w`, which
 * points up in the image (decreasing v): the OpenGL convention of the
 * normal maps, as in glTF. The tangents of the triangles sharing a vertex
 * are averaged (Lengyel's method).
 *
 * The mesh needs positions (float32x3), normals (float32x3) and uvs
 * (float32x2), as a triangle list; the other buffers are shared with it.
 * Without tangents, the macros compute a frame from the screen space
 * derivatives instead, for more shader work and less precision.
 */
export function computeTangents(mesh: Mesh): Mesh {
  const position = attributeReader(mesh, 'position', 'float32x3');
  const normal = attributeReader(mesh, 'normal', 'float32x3');
  const uv = attributeReader(mesh, 'uv', 'float32x2');
  if (!position || !normal || !uv) {
    throw new Error(
      'computeTangents: the mesh needs position, normal and uv attributes',
    );
  }
  if (
    mesh.description.vertexBuffers.some((layout) =>
      layout.attributes.some((attribute) => attribute.semantic === 'tangent'),
    )
  ) {
    throw new Error('computeTangents: the mesh already has tangents');
  }
  const count = mesh.description.vertexCount;
  const indices = mesh.indices;
  const corners = indices ? (mesh.description.indexBuffer?.count ?? 0) : count;
  const corner = (i: number) => (indices ? indices[i] : i);

  // The sums of the directions of increasing u and v of the triangles.
  const tangents = new Float64Array(count * 3);
  const bitangents = new Float64Array(count * 3);
  for (let i = 0; i + 2 < corners; i += 3) {
    const [a, b, c] = [corner(i), corner(i + 1), corner(i + 2)];
    const e1 = [0, 1, 2].map((k) => position(b, k) - position(a, k));
    const e2 = [0, 1, 2].map((k) => position(c, k) - position(a, k));
    const du1 = uv(b, 0) - uv(a, 0);
    const dv1 = uv(b, 1) - uv(a, 1);
    const du2 = uv(c, 0) - uv(a, 0);
    const dv2 = uv(c, 1) - uv(a, 1);
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) {
      continue;
    }
    const r = 1 / det;
    for (let k = 0; k < 3; k++) {
      const t = (e1[k] * dv2 - e2[k] * dv1) * r;
      const s = (e2[k] * du1 - e1[k] * du2) * r;
      for (const vertex of [a, b, c]) {
        tangents[vertex * 3 + k] += t;
        bitangents[vertex * 3 + k] += s;
      }
    }
  }

  // Orthogonal to the normal (Gram-Schmidt), with the handedness of the
  // frame: the bitangent up in the image is the opposite of dP/dv.
  const data = new Float32Array(count * 4);
  for (let vertex = 0; vertex < count; vertex++) {
    const n = [0, 1, 2].map((k) => normal(vertex, k));
    const t = [0, 1, 2].map((k) => tangents[vertex * 3 + k]);
    const along = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    let ortho = t.map((value, k) => value - n[k] * along);
    let length = Math.hypot(...ortho);
    if (length < 1e-12) {
      // No uv gradient: any direction perpendicular to the normal.
      const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const dot = n[0] * helper[0] + n[1] * helper[1] + n[2] * helper[2];
      ortho = helper.map((value, k) => value - n[k] * dot);
      length = Math.hypot(...ortho);
    }
    ortho = ortho.map((value) => value / length);
    const cross = [
      n[1] * ortho[2] - n[2] * ortho[1],
      n[2] * ortho[0] - n[0] * ortho[2],
      n[0] * ortho[1] - n[1] * ortho[0],
    ];
    const dv = [0, 1, 2].map((k) => bitangents[vertex * 3 + k]);
    const w =
      cross[0] * dv[0] + cross[1] * dv[1] + cross[2] * dv[2] > 0 ? -1 : 1;
    data.set([ortho[0], ortho[1], ortho[2], w], vertex * 4);
  }

  return new Mesh({
    ...(mesh.label ? { label: mesh.label } : {}),
    description: {
      ...mesh.description,
      vertexBuffers: [
        ...mesh.description.vertexBuffers,
        {
          stride: 16,
          stepMode: 'vertex',
          attributes: [{ semantic: 'tangent', format: 'float32x4', offset: 0 }],
        },
      ],
    },
    vertices: [...mesh.vertices, data],
    ...(indices ? { indices } : {}),
  });
}
