import type { Mesh } from './Mesh';

/** A bounding sphere. */
export interface Sphere {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

const meshSpheres = new WeakMap<
  Mesh,
  { readonly version: number; readonly sphere: Sphere | undefined }
>();

/**
 * The bounding sphere of the positions of a mesh (its `position` attribute
 * in float32x3), in the space of the mesh; undefined without positions.
 * Computed once per version of the mesh.
 */
export function meshBounds(mesh: Mesh): Sphere | undefined {
  const cached = meshSpheres.get(mesh);
  if (cached && cached.version === mesh.version) {
    return cached.sphere;
  }
  let sphere: Sphere | undefined;
  mesh.description.vertexBuffers.forEach((layout, buffer) => {
    const attribute = layout.attributes.find(
      (candidate) =>
        candidate.semantic === 'position' && candidate.format === 'float32x3'
    );
    if (!attribute || sphere) {
      return;
    }
    const data = mesh.vertices[buffer];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = Math.floor(
      (data.byteLength - attribute.offset + layout.stride - 12) / layout.stride
    );
    if (count <= 0) {
      return;
    }
    const position = (i: number, axis: number) =>
      view.getFloat32(i * layout.stride + attribute.offset + axis * 4, true);
    // Center of the bounding box, then the farthest point from it.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = position(i, axis);
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
    const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2) as [
      number,
      number,
      number
    ];
    let radius = 0;
    for (let i = 0; i < count; i++) {
      radius = Math.max(
        radius,
        Math.hypot(
          position(i, 0) - center[0],
          position(i, 1) - center[1],
          position(i, 2) - center[2]
        )
      );
    }
    sphere = { center, radius };
  });
  meshSpheres.set(mesh, { version: mesh.version, sphere });
  return sphere;
}

/**
 * A sphere transformed by a matrix (4 × 4, column-major): its center is
 * transformed, its radius scaled by the largest scale of the matrix.
 */
export function transformSphere(
  { center: [x, y, z], radius }: Sphere,
  m: ArrayLike<number>
): Sphere {
  const scale = Math.max(
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[4], m[5], m[6]),
    Math.hypot(m[8], m[9], m[10])
  );
  return {
    center: [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ],
    radius: radius * scale,
  };
}

/** A sphere containing spheres; undefined for none. */
export function unionSpheres(spheres: readonly Sphere[]): Sphere | undefined {
  if (spheres.length === 0) {
    return undefined;
  }
  // Centered on the bounding box of the spheres.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { center, radius } of spheres) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], center[axis] - radius);
      max[axis] = Math.max(max[axis], center[axis] + radius);
    }
  }
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2) as [
    number,
    number,
    number
  ];
  const radius = Math.max(
    ...spheres.map(
      (sphere) =>
        Math.hypot(
          sphere.center[0] - center[0],
          sphere.center[1] - center[1],
          sphere.center[2] - center[2]
        ) + sphere.radius
    )
  );
  return { center, radius };
}
