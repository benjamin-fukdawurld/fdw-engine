import type {
  MeshAttributeDescription,
  VertexAttributeFormat,
} from '@fdw/engine-backend';
import { Mesh } from './Mesh';

/** A mesh placed in the world, to merge with others (mergeMeshes). */
export interface MeshPart {
  readonly mesh: Mesh;
  // Its world matrix, column-major (16 values).
  readonly matrix: ArrayLike<number>;
  // The identifier of its object, given to each of its vertices.
  readonly id?: number;
}

// The attributes moved by the matrix, in the formats they can be read in.
const moved: Record<string, readonly VertexAttributeFormat[]> = {
  position: ['float32x3', 'float32x4'],
  normal: ['float32x3'],
  tangent: ['float32x4'],
};
// Deformed on the GPU from their own space: not mergeable.
const skinned = new Set(['joints', 'weights']);

const formatSize = (format: VertexAttributeFormat): number => {
  const match = /^[a-z]+?(8|16|32)(?:x(\d))?$/.exec(format);
  if (!match) {
    throw new Error(`Unknown vertex format ${format}`);
  }
  return (Number(match[1]) / 8) * Number(match[2] ?? 1);
};

const attributesOf = (mesh: Mesh) =>
  mesh.description.vertexBuffers.flatMap((buffer, index) =>
    buffer.attributes.map((attribute) => ({ ...attribute, buffer: index })),
  );

/**
 * What a mesh must share with others to be merged with them (mergeMeshes):
 * its attributes and their formats. Undefined when it cannot be merged:
 * other primitives than triangles, instanced buffers, skinned vertices,
 * positions, normals or tangents in other formats than 32-bit floats, an
 * `objectId` attribute of its own.
 */
export function mergeKey(mesh: Mesh): string | undefined {
  const { description } = mesh;
  if (
    (description.topology ?? 'triangle-list') !== 'triangle-list' ||
    description.vertexBuffers.some((buffer) => buffer.stepMode !== 'vertex')
  ) {
    return undefined;
  }
  const attributes = attributesOf(mesh);
  if (!attributes.some((attribute) => attribute.semantic === 'position')) {
    return undefined;
  }
  for (const { semantic, format } of attributes) {
    if (
      skinned.has(semantic) ||
      semantic === 'objectId' ||
      (moved[semantic] && !moved[semantic].includes(format))
    ) {
      return undefined;
    }
  }
  return attributes
    .map(({ semantic, format }) => `${semantic}:${format}`)
    .sort()
    .join(',');
}

/**
 * One mesh in world space from meshes placed in the world, of the same
 * mergeKey: the static batching. The positions, normals and tangents are
 * transformed, the other attributes copied, the faces of a mirrored part
 * turned back. The attributes are interleaved in one vertex buffer, in the
 * order of mergeKey; with `ids` (the default), a second buffer gives each
 * vertex the identifier of its part (`objectId`, uint32), which the
 * 'object-id' outputs of the scene passes read. The indices are 16-bit
 * when they can be.
 */
export function mergeMeshes(
  parts: readonly MeshPart[],
  { ids = true, label }: { ids?: boolean; label?: string } = {},
): Mesh {
  if (parts.length === 0) {
    throw new Error('mergeMeshes needs at least one mesh');
  }
  const key = mergeKey(parts[0].mesh);
  if (key === undefined) {
    throw new Error(
      `The mesh "${parts[0].mesh.label ?? 'mesh'}" cannot be merged`,
    );
  }
  for (const { mesh } of parts) {
    if (mergeKey(mesh) !== key) {
      throw new Error(
        `The mesh "${mesh.label ?? 'mesh'}" has other attributes than "${
          parts[0].mesh.label ?? 'mesh'
        }": they cannot be merged`,
      );
    }
  }
  // The layout of the merged vertices: the attributes of the key, packed.
  const layout: MeshAttributeDescription[] = [];
  let stride = 0;
  for (const entry of key.split(',')) {
    const [semantic, format] = entry.split(':') as [
      string,
      VertexAttributeFormat,
    ];
    layout.push({ semantic, format, offset: stride });
    stride += formatSize(format);
  }
  // Vertex buffers are read four bytes at a time on some backends.
  stride = Math.ceil(stride / 4) * 4;

  let vertexCount = 0;
  let indexCount = 0;
  for (const { mesh } of parts) {
    vertexCount += mesh.description.vertexCount;
    indexCount +=
      mesh.description.indexBuffer?.count ?? mesh.description.vertexCount;
  }
  const bytes = new Uint8Array(vertexCount * stride);
  const out = new DataView(bytes.buffer);
  const objectIds = ids ? new Uint32Array(vertexCount) : undefined;
  const indices =
    vertexCount <= 0xffff
      ? new Uint16Array(indexCount)
      : new Uint32Array(indexCount);

  let firstVertex = 0;
  let firstIndex = 0;
  const normalMatrix = new Float64Array(9);
  for (const { mesh, matrix: m, id = 0 } of parts) {
    const count = mesh.description.vertexCount;
    // The inverse transpose of the upper 3 × 3, for the normals: its
    // cofactors, over the determinant.
    const det =
      m[0] * (m[5] * m[10] - m[9] * m[6]) -
      m[4] * (m[1] * m[10] - m[9] * m[2]) +
      m[8] * (m[1] * m[6] - m[5] * m[2]);
    const n = normalMatrix;
    n[0] = m[5] * m[10] - m[6] * m[9];
    n[1] = m[6] * m[8] - m[4] * m[10];
    n[2] = m[4] * m[9] - m[5] * m[8];
    n[3] = m[9] * m[2] - m[1] * m[10];
    n[4] = m[0] * m[10] - m[8] * m[2];
    n[5] = m[8] * m[1] - m[0] * m[9];
    n[6] = m[1] * m[6] - m[5] * m[2];
    n[7] = m[4] * m[2] - m[0] * m[6];
    n[8] = m[0] * m[5] - m[4] * m[1];
    const mirrored = det < 0;
    // The sign of the determinant only: the normals are normalized.
    if (mirrored) {
      n.forEach((value, i) => (n[i] = -value));
    }

    for (const attribute of attributesOf(mesh)) {
      const target = layout.find(
        (candidate) => candidate.semantic === attribute.semantic,
      ) as MeshAttributeDescription;
      const source = mesh.vertices[attribute.buffer];
      const sourceStride =
        mesh.description.vertexBuffers[attribute.buffer].stride;
      const view = new DataView(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
      const size = formatSize(attribute.format);
      const sourceBytes = new Uint8Array(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
      const semantic = attribute.semantic;
      for (let i = 0; i < count; i++) {
        const from = i * sourceStride + attribute.offset;
        const to = (firstVertex + i) * stride + target.offset;
        if (!moved[semantic]) {
          bytes.set(sourceBytes.subarray(from, from + size), to);
          continue;
        }
        const x = view.getFloat32(from, true);
        const y = view.getFloat32(from + 4, true);
        const z = view.getFloat32(from + 8, true);
        let rx: number;
        let ry: number;
        let rz: number;
        if (semantic === 'position') {
          rx = m[0] * x + m[4] * y + m[8] * z + m[12];
          ry = m[1] * x + m[5] * y + m[9] * z + m[13];
          rz = m[2] * x + m[6] * y + m[10] * z + m[14];
        } else {
          // Normals by the inverse transpose, tangents by the matrix.
          const t = semantic === 'normal' ? n : undefined;
          rx = t
            ? t[0] * x + t[3] * y + t[6] * z
            : m[0] * x + m[4] * y + m[8] * z;
          ry = t
            ? t[1] * x + t[4] * y + t[7] * z
            : m[1] * x + m[5] * y + m[9] * z;
          rz = t
            ? t[2] * x + t[5] * y + t[8] * z
            : m[2] * x + m[6] * y + m[10] * z;
          const length = Math.hypot(rx, ry, rz) || 1;
          rx /= length;
          ry /= length;
          rz /= length;
        }
        out.setFloat32(to, rx, true);
        out.setFloat32(to + 4, ry, true);
        out.setFloat32(to + 8, rz, true);
        if (size === 16) {
          const w = view.getFloat32(from + 12, true);
          // The bitangent of a tangent turns with a mirror.
          out.setFloat32(
            to + 12,
            semantic === 'tangent' && mirrored ? -w : w,
            true,
          );
        }
      }
    }
    objectIds?.fill(id, firstVertex, firstVertex + count);

    const source = mesh.indices;
    const faces = source?.length ?? count;
    for (let i = 0; i < faces; i += 3) {
      const a = source ? source[i] : i;
      const b = source ? source[i + 1] : i + 1;
      const c = source ? source[i + 2] : i + 2;
      indices[firstIndex + i] = firstVertex + a;
      // A mirror turns the faces over: the winding is reversed back.
      indices[firstIndex + i + 1] = firstVertex + (mirrored ? c : b);
      indices[firstIndex + i + 2] = firstVertex + (mirrored ? b : c);
    }
    firstVertex += count;
    firstIndex += faces;
  }

  return new Mesh({
    label: label ?? `merged (${parts.length})`,
    description: {
      vertexBuffers: [
        { stride, stepMode: 'vertex', attributes: layout },
        ...(objectIds
          ? [
              {
                stride: 4,
                stepMode: 'vertex' as const,
                attributes: [
                  {
                    semantic: 'objectId',
                    format: 'uint32' as const,
                    offset: 0,
                  },
                ],
              },
            ]
          : []),
      ],
      vertexCount,
      indexBuffer: {
        format: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        count: indexCount,
      },
    },
    vertices: objectIds ? [bytes, objectIds] : [bytes],
    indices,
  });
}
