import type { MeshAttributeDescription } from '@fdw/engine-backend';
import { Mesh } from '@fdw/engine-core';
import type { MeshData } from './obj-importer';

// The primitives are shared with the native demo.
export { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';

// An engine mesh from the interleaved data of the OBJ importer: position,
// then normal and uv when present. Indices are 32-bit beyond 65 535 vertices.
export function meshFromObj(data: MeshData, label?: string): Mesh {
  const attributes: MeshAttributeDescription[] = [
    { semantic: 'position', format: 'float32x3', offset: 0 },
  ];
  let offset = 12;
  if (data.hasNormals) {
    attributes.push({ semantic: 'normal', format: 'float32x3', offset });
    offset += 12;
  }
  if (data.hasUVs) {
    attributes.push({ semantic: 'uv', format: 'float32x2', offset });
  }

  const vertexCount = data.vertices.length / data.stride;
  const wide = vertexCount > 0xffff;
  return new Mesh({
    label,
    description: {
      vertexBuffers: [
        { stride: data.stride * 4, stepMode: 'vertex', attributes },
      ],
      vertexCount,
      indexBuffer: {
        format: wide ? 'uint32' : 'uint16',
        count: data.indices.length,
      },
    },
    vertices: [new Float32Array(data.vertices)],
    indices: wide
      ? new Uint32Array(data.indices)
      : new Uint16Array(data.indices),
  });
}
