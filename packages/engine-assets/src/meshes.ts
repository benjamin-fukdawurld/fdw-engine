import { computeTangents, Mesh } from '@fdw/engine-core';
import { defineResourceType, type ResourceLoader } from '@fdw/engine-resources';
import { MeshDataType } from './data';
import { AssetsConfigService } from './services';

export interface MeshOptions {
  /**
   * Computes the tangents when the mesh has none (a material with a normal
   * map); it needs normals and uv. False by default: without tangents, the
   * normal maps use a frame computed from the derivatives on the screen.
   */
  readonly tangents?: boolean;
}

export const MeshType = defineResourceType<Mesh>('mesh');

const hasAttribute = (mesh: Mesh, semantic: string) =>
  mesh.description.vertexBuffers.some((b) =>
    b.attributes.some((a) => a.semantic === semantic)
  );

/**
 * Meshes from their data (`MeshDataType`, a sub-resource of a model). The
 * `Mesh` sends itself to the GPU when first drawn; `dispose` frees its
 * buffers in every renderer. A reload with the same layout updates it in
 * place: the nodes drawing it see the new vertices.
 */
export const meshLoader: ResourceLoader<Mesh, MeshOptions | undefined> = {
  type: MeshType,
  cacheKey: (options) => (options?.tangents ? 'tangents' : ''),
  async load(ctx) {
    const data = await ctx.use(MeshDataType, ctx.uri).ready;
    let mesh = new Mesh({
      description: data.description,
      vertices: data.vertices,
      indices: data.indices,
      label: data.name ?? ctx.uri,
    });
    if (ctx.options?.tangents && !hasAttribute(mesh, 'tangent')) {
      try {
        mesh = computeTangents(mesh);
      } catch (e) {
        ctx
          .service(AssetsConfigService)
          .warn(`${ctx.uri}: no tangents (${(e as Error).message})`);
      }
    }
    return mesh;
  },
  update(current, next) {
    if (
      JSON.stringify(current.description) !== JSON.stringify(next.description)
    )
      return false;
    next.vertices.forEach((data, i) => current.setVertices(i, data));
    if (next.indices) current.setIndices(next.indices);
    return true;
  },
  dispose: (mesh) => mesh.destroy(),
  sizeOf: (mesh) =>
    mesh.vertices.reduce((sum, v) => sum + v.byteLength, 0) +
    (mesh.indices?.byteLength ?? 0),
};
