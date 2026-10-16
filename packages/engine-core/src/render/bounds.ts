import { Aabb } from '@fdw/engine-geometry';
import type { Mesh } from './Mesh';

/** A bounding sphere. */
export interface Sphere {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

interface MeshBounds {
  readonly version: number;
  readonly sphere: Sphere | undefined;
  readonly box: Aabb | undefined;
}

const cache = new WeakMap<Mesh, MeshBounds>();

// The bounds of the positions of a mesh (its `position` attribute in
// float32x3): a box, and a sphere around its center. Computed once per
// version of the mesh.
function boundsOf(mesh: Mesh): MeshBounds {
  const cached = cache.get(mesh);
  if (cached && cached.version === mesh.version) {
    return cached;
  }
  let sphere: Sphere | undefined;
  let box: Aabb | undefined;
  mesh.description.vertexBuffers.forEach((layout, buffer) => {
    const attribute = layout.attributes.find(
      (candidate) =>
        candidate.semantic === 'position' && candidate.format === 'float32x3',
    );
    if (!attribute || sphere) {
      return;
    }
    const data = mesh.vertices[buffer];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = Math.floor(
      (data.byteLength - attribute.offset + layout.stride - 12) / layout.stride,
    );
    if (count <= 0) {
      return;
    }
    const position = (i: number, axis: number) =>
      view.getFloat32(i * layout.stride + attribute.offset + axis * 4, true);
    // The bounding box, then the farthest point from its center.
    box = Aabb.empty();
    const point: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      point[0] = position(i, 0);
      point[1] = position(i, 1);
      point[2] = position(i, 2);
      box.expandByPoint(point);
    }
    const center = box.center();
    let radius = 0;
    for (let i = 0; i < count; i++) {
      radius = Math.max(
        radius,
        Math.hypot(
          position(i, 0) - center[0],
          position(i, 1) - center[1],
          position(i, 2) - center[2],
        ),
      );
    }
    sphere = { center, radius };
  });
  const bounds = { version: mesh.version, sphere, box };
  cache.set(mesh, bounds);
  return bounds;
}

/**
 * The bounding sphere of the positions of a mesh, in the space of the mesh;
 * undefined without positions. Computed once per version of the mesh.
 */
export function meshBounds(mesh: Mesh): Sphere | undefined {
  return boundsOf(mesh).sphere;
}

/**
 * The bounding box of the positions of a mesh, in the space of the mesh;
 * undefined without positions. Computed once per version of the mesh, with
 * the sphere of meshBounds().
 */
export function meshBox(mesh: Mesh): Aabb | undefined {
  return boundsOf(mesh).box;
}
