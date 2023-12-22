import { IMeshBuilder, MeshBuffers, MeshData, VertexAttributes } from './types';

export class MeshBuilder implements IMeshBuilder {
  public toBuffers({
    mesh,
    interlaced,
    attributes,
  }: {
    mesh: MeshData;
    attributes: VertexAttributes[];
    interlaced: boolean;
  }): MeshBuffers {
    const vertexCount = mesh.indices.length / 3;
    const stride = attributes.reduce((total, attr) => {
      switch (attr) {
        case 'pos':
        case 'norm':
          return total + 3;

        case 'uv':
          return total + 2;
      }
    }, 0);
    const vertices = new Float32Array(vertexCount * stride);

    if (!interlaced) {
      vertices.set(mesh.positions, 0);
      vertices.set(mesh.uvs, mesh.positions.length);
      vertices.set(mesh.normals, mesh.positions.length + mesh.uvs.length);

      return {
        vertices,
        attributes,
        interlaced,
        vertexCount,
      };
    }

    return {
      vertices,
      attributes,
      interlaced,
      vertexCount,
    };
  }
}
