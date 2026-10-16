import type { MeshData } from '@fdw/engine-assets';
import type {
  MeshBufferDescription,
  VertexAttributeFormat,
} from '@fdw/engine-backend';
import { normalizationDivisor, toFloat32 } from './accessors';
import type { GltfAttributeData, GltfTypedArray } from './extension';

// From the attributes of a glTF primitive to the layout of a `Mesh`: one
// vertex buffer per attribute, in a format WebGPU accepts, and triangle
// lists only.

/** The primitive modes of glTF. */
export const GltfMode = {
  POINTS: 0,
  LINES: 1,
  LINE_LOOP: 2,
  LINE_STRIP: 3,
  TRIANGLES: 4,
  TRIANGLE_STRIP: 5,
  TRIANGLE_FAN: 6,
} as const;

/**
 * The semantic of an attribute of glTF, in the naming of the engine:
 * `TEXCOORD_1` → `uv1`, `COLOR_0` → `color`. Custom attributes (`_ID`) keep
 * their name.
 */
export function attributeSemantic(name: string): string {
  const fixed: Record<string, string> = {
    POSITION: 'position',
    NORMAL: 'normal',
    TANGENT: 'tangent',
  };
  if (fixed[name]) return fixed[name];
  const match = /^(TEXCOORD|COLOR|JOINTS|WEIGHTS)_(\d+)$/.exec(name);
  if (!match) return name;
  const base = {
    TEXCOORD: 'uv',
    COLOR: 'color',
    JOINTS: 'joints',
    WEIGHTS: 'weights',
  }[match[1]];
  return match[2] === '0' ? base! : `${base}${match[2]}`;
}

// Widens each element to `to` components, filling with `fill`.
function pad(
  array: GltfTypedArray,
  from: number,
  to: number,
  fill: number
): GltfTypedArray {
  const count = array.length / from;
  const out = new (array.constructor as new (length: number) => GltfTypedArray)(
    count * to
  );
  out.fill(fill);
  for (let i = 0; i < count; i++)
    out.set(array.subarray(i * from, (i + 1) * from), i * to);
  return out;
}

const formatName = (kind: string, components: number) =>
  (components === 1 ? kind : `${kind}x${components}`) as VertexAttributeFormat;

/**
 * An attribute in a vertex format: float32 as is; normalized integers as
 * `snorm8x4`, `unorm16x2`… (`KHR_mesh_quantization`); joints as `uint8x4` /
 * `uint16x4`; other integers converted to floats, since the shaders read
 * them as floats and WebGPU has no format converting integers unnormalized.
 * WebGPU wants 4-byte multiples, and has no 3-component 8 or 16-bit format:
 * such attributes are padded (a copy, once). Colors get an opaque alpha:
 * the graphs read them as vec4.
 */
export function vertexAttribute(
  semantic: string,
  data: GltfAttributeData
): {
  readonly format: VertexAttributeFormat;
  readonly array: GltfTypedArray;
  readonly components: number;
} {
  const color = /^color\d*$/.test(semantic);
  let { array, components } = data;
  const integer =
    !(array instanceof Float32Array) && !(array instanceof Uint32Array);
  const kind = !integer
    ? undefined
    : data.normalized
    ? array instanceof Int8Array || array instanceof Int16Array
      ? 'snorm'
      : 'unorm'
    : /^joints\d*$/.test(semantic)
    ? array instanceof Int8Array || array instanceof Int16Array
      ? 'sint'
      : 'uint'
    : undefined;
  if (!kind) {
    array = toFloat32(data);
    if (color && components === 3) {
      array = pad(array, 3, 4, 1);
      components = 4;
    }
    return { format: formatName('float32', components), array, components };
  }
  const size = array.BYTES_PER_ELEMENT;
  const padded =
    size === 1 ? 4 : components === 1 ? 2 : components === 3 ? 4 : components;
  if (padded !== components) {
    array = pad(
      array,
      components,
      padded,
      color ? normalizationDivisor(array) : 0
    );
    components = padded;
  }
  return {
    format: formatName(`${kind}${size * 8}`, components),
    array,
    components,
  };
}

/** Triangle lists from strips and fans; the indices of a list as they are. */
export function triangleList(
  mode: number,
  indices: ArrayLike<number> | undefined,
  vertexCount: number
): ArrayLike<number> | undefined {
  if (mode === GltfMode.TRIANGLES) return indices;
  const at = indices ? (i: number) => indices[i] : (i: number) => i;
  const count = indices ? indices.length : vertexCount;
  const triangles = Math.max(count - 2, 0);
  const out =
    vertexCount > 65536
      ? new Uint32Array(triangles * 3)
      : new Uint16Array(triangles * 3);
  for (let i = 0; i < triangles; i++) {
    if (mode === GltfMode.TRIANGLE_FAN)
      out.set([at(0), at(i + 1), at(i + 2)], i * 3);
    // Every other triangle of a strip is reversed, to keep the winding.
    else
      out.set(
        i % 2 === 0
          ? [at(i), at(i + 1), at(i + 2)]
          : [at(i + 1), at(i), at(i + 2)],
        i * 3
      );
  }
  return out;
}

/** Indices as a `Mesh` takes them: uint8 widened to uint16 (WebGPU has no 8-bit indices). */
export function indexData(
  indices: ArrayLike<number>
): Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer> {
  if (indices instanceof Uint16Array || indices instanceof Uint32Array) {
    return indices as Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  }
  return Uint16Array.from(indices);
}

interface VertexBuffer {
  readonly layout: MeshBufferDescription;
  readonly array: ArrayBufferView<ArrayBuffer>;
}

/**
 * Flat normals, as glTF asks for a primitive without them: the vertices are
 * unwelded (one per corner of each triangle), and each corner gets the
 * normal of its triangle.
 */
function flatNormals(
  buffers: VertexBuffer[],
  positions: Float32Array,
  indices: ArrayLike<number> | undefined,
  vertexCount: number
) {
  const count = Math.floor((indices ? indices.length : vertexCount) / 3) * 3;
  const at = indices ? (i: number) => indices[i] : (i: number) => i;
  const unwelded = buffers.map(({ layout, array }) => {
    const source = new Uint8Array(
      array.buffer,
      array.byteOffset,
      array.byteLength
    );
    const out = new Uint8Array(count * layout.stride);
    for (let i = 0; i < count; i++)
      out.set(
        source.subarray(at(i) * layout.stride, (at(i) + 1) * layout.stride),
        i * layout.stride
      );
    // In the type of the source: the vertices read as they were.
    return {
      layout,
      array: new (array.constructor as new (
        buffer: ArrayBuffer
      ) => ArrayBufferView<ArrayBuffer>)(out.buffer),
    };
  });
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < count; t += 3) {
    const [a, b, c] = [at(t) * 3, at(t + 1) * 3, at(t + 2) * 3];
    const u = [
      positions[b] - positions[a],
      positions[b + 1] - positions[a + 1],
      positions[b + 2] - positions[a + 2],
    ];
    const v = [
      positions[c] - positions[a],
      positions[c + 1] - positions[a + 1],
      positions[c + 2] - positions[a + 2],
    ];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let k = 0; k < 3; k++)
      normals.set([n[0] / length, n[1] / length, n[2] / length], (t + k) * 3);
  }
  unwelded.push({
    layout: {
      stride: 12,
      stepMode: 'vertex',
      attributes: [{ semantic: 'normal', format: 'float32x3', offset: 0 }],
    },
    array: normals,
  });
  return { buffers: unwelded, vertexCount: count };
}

export interface PrimitiveGeometry {
  readonly name?: string;
  /** By glTF name (`POSITION`, `TEXCOORD_0`); `POSITION` is required. */
  readonly attributes: ReadonlyMap<string, GltfAttributeData>;
  readonly indices?: ArrayLike<number>;
  /** Triangles, strip or fan. */
  readonly mode: number;
  /** Computes flat normals when there are none (the lit materials need them). */
  readonly normals: boolean;
}

/** The `MeshData` of a primitive. */
export function primitiveMeshData({
  name,
  attributes,
  indices,
  mode,
  normals,
}: PrimitiveGeometry): MeshData {
  const position = attributes.get('POSITION');
  if (!position) throw new Error('A primitive without POSITION');
  const vertexCount = position.array.length / position.components;
  let buffers: VertexBuffer[] = [...attributes].map(([name, data]) => {
    const semantic = attributeSemantic(name);
    const { format, array, components } = vertexAttribute(semantic, data);
    if (array.length / components !== vertexCount)
      throw new Error(`Attribute ${name} has not as many values as POSITION`);
    return {
      layout: {
        stride: components * array.BYTES_PER_ELEMENT,
        stepMode: 'vertex',
        attributes: [{ semantic, format, offset: 0 }],
      },
      array,
    };
  });
  let list = triangleList(mode, indices, vertexCount);
  let count = vertexCount;
  if (normals && !attributes.has('NORMAL')) {
    ({ buffers, vertexCount: count } = flatNormals(
      buffers,
      toFloat32(position),
      list,
      vertexCount
    ));
    list = undefined;
  }
  const index = list && indexData(list);
  return {
    name,
    description: {
      vertexBuffers: buffers.map((b) => b.layout),
      vertexCount: count,
      ...(index
        ? {
            indexBuffer: {
              format: index instanceof Uint16Array ? 'uint16' : 'uint32',
              count: index.length,
            },
          }
        : {}),
    },
    vertices: buffers.map((b) => b.array),
    ...(index ? { indices: index } : {}),
  };
}
