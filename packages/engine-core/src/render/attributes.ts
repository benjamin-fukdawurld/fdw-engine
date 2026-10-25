import type { VertexAttributeFormat } from '@fdw/engine-backend';
import type { Mesh } from './Mesh';

type Read = (view: DataView, offset: number) => number;

// A 16 bits float, from its bits.
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 31) {
    return fraction ? NaN : sign * Infinity;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

// How to read one component of a format, and its size in bytes.
function componentReader(format: VertexAttributeFormat): [Read, number] {
  const kind = format.replace(/x\d$/, '');
  switch (kind) {
    case 'float32':
      return [(v, o) => v.getFloat32(o, true), 4];
    case 'float16':
      return [(v, o) => halfToFloat(v.getUint16(o, true)), 2];
    case 'uint32':
      return [(v, o) => v.getUint32(o, true), 4];
    case 'sint32':
      return [(v, o) => v.getInt32(o, true), 4];
    case 'uint16':
      return [(v, o) => v.getUint16(o, true), 2];
    case 'sint16':
      return [(v, o) => v.getInt16(o, true), 2];
    case 'unorm16':
      return [(v, o) => v.getUint16(o, true) / 65535, 2];
    case 'snorm16':
      return [(v, o) => Math.max(v.getInt16(o, true) / 32767, -1), 2];
    case 'uint8':
      return [(v, o) => v.getUint8(o), 1];
    case 'sint8':
      return [(v, o) => v.getInt8(o), 1];
    case 'unorm8':
      return [(v, o) => v.getUint8(o) / 255, 1];
    case 'snorm8':
      return [(v, o) => Math.max(v.getInt8(o) / 127, -1), 1];
    default:
      throw new Error(`Cannot read the vertex format ${format}`);
  }
}

/**
 * The values of an attribute of a mesh, by semantic, `components` numbers
 * a vertex (missing components are 0): integers as they are, normalized
 * integers as floats from 0 to 1 (or -1 to 1). Undefined when the mesh
 * has no such attribute.
 */
export function readAttribute(
  mesh: Mesh,
  semantic: string,
  components: number,
): Float32Array<ArrayBuffer> | undefined {
  const { vertexBuffers, vertexCount } = mesh.description;
  for (const [buffer, layout] of vertexBuffers.entries()) {
    const attribute = layout.attributes.find((a) => a.semantic === semantic);
    if (!attribute) {
      continue;
    }
    const [read, size] = componentReader(attribute.format);
    const available = Number(/x(\d)$/.exec(attribute.format)?.[1] ?? 1);
    const data = mesh.vertices[buffer];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Float32Array(vertexCount * components);
    const count = Math.min(available, components);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const offset = vertex * layout.stride + attribute.offset;
      for (let c = 0; c < count; c++) {
        out[vertex * components + c] = read(view, offset + c * size);
      }
    }
    return out;
  }
  return undefined;
}

/** Whether the mesh has an attribute of this semantic. */
export const hasAttribute = (mesh: Mesh, semantic: string): boolean =>
  mesh.description.vertexBuffers.some((layout) =>
    layout.attributes.some((attribute) => attribute.semantic === semantic),
  );
