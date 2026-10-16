import {
  GltfComponentType,
  type GltfAccessor,
  type GltfAccessorType,
} from '../types';

// Writes small glTF files for the tests: the JSON, and a binary buffer the
// accessors are appended to.

type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Uint32Array
  | Float32Array;

const componentTypes = new Map<unknown, number>([
  [Int8Array, GltfComponentType.BYTE],
  [Uint8Array, GltfComponentType.UNSIGNED_BYTE],
  [Int16Array, GltfComponentType.SHORT],
  [Uint16Array, GltfComponentType.UNSIGNED_SHORT],
  [Uint32Array, GltfComponentType.UNSIGNED_INT],
  [Float32Array, GltfComponentType.FLOAT],
]);

const counts: Record<GltfAccessorType, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const bytesOf = (array: ArrayBufferView) =>
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

/** A GLB file from its JSON and its BIN chunk. */
export function writeGlb(
  json: object,
  bin?: Uint8Array
): Uint8Array<ArrayBuffer> {
  const pad = (bytes: Uint8Array, fill: number) => {
    const out = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
    out.set(bytes);
    return out;
  };
  const chunks: [number, Uint8Array][] = [
    [0x4e4f534a, pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)],
  ];
  if (bin) chunks.push([0x004e4942, pad(bin, 0)]);
  const length =
    12 + chunks.reduce((sum, [, data]) => sum + 8 + data.byteLength, 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  let offset = 12;
  for (const [type, data] of chunks) {
    view.setUint32(offset, data.byteLength, true);
    view.setUint32(offset + 4, type, true);
    out.set(data, offset + 8);
    offset += 8 + data.byteLength;
  }
  return out;
}

export class GltfBuilder {
  readonly json: Record<string, any> = { asset: { version: '2.0' } };
  private data = new Uint8Array(0);

  /** Appends an object to a list of the JSON (`meshes`, `nodes`…), and returns its index. */
  add(list: string, item: object): number {
    const items: object[] = (this.json[list] ??= []);
    return items.push(item) - 1;
  }

  /** Appends bytes to the buffer, 4-byte aligned, and returns their offset. */
  append(bytes: Uint8Array | ArrayBufferView): number {
    const offset = Math.ceil(this.data.byteLength / 4) * 4;
    const raw = bytesOf(bytes);
    const data = new Uint8Array(offset + raw.byteLength);
    data.set(this.data);
    data.set(raw, offset);
    this.data = data;
    return offset;
  }

  bufferView(
    bytes: ArrayBufferView,
    extra: Record<string, unknown> = {}
  ): number {
    const byteOffset = this.append(bytes);
    return this.add('bufferViews', {
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      ...extra,
    });
  }

  /** An accessor of tightly packed values, in a buffer view of its own. */
  accessor(
    array: TypedArray,
    type: GltfAccessorType,
    extra: Partial<GltfAccessor> = {}
  ): number {
    const componentType = componentTypes.get(array.constructor)!;
    return this.add('accessors', {
      bufferView: this.bufferView(array),
      componentType,
      count: array.length / counts[type],
      type,
      ...extra,
    });
  }

  /** A mesh of one primitive, and a node drawing it; returns the node. */
  meshNode(primitive: object, name?: string): number {
    const mesh = this.add('meshes', {
      ...(name ? { name } : {}),
      primitives: [primitive],
    });
    return this.add('nodes', { mesh });
  }

  get bin(): Uint8Array<ArrayBuffer> {
    return this.data as Uint8Array<ArrayBuffer>;
  }

  /** The binary file: the buffer 0 is the BIN chunk. */
  glb(): Uint8Array<ArrayBuffer> {
    this.json.buffers = [
      { byteLength: this.data.byteLength },
      ...(this.json.buffers ?? []).slice(1),
    ];
    return writeGlb(this.json, this.data);
  }

  /** The JSON file, its buffer 0 in an external file `uri`, or a base64 data URI. */
  gltf(uri?: string): string {
    const base64 = () =>
      `data:application/octet-stream;base64,${Buffer.from(this.data).toString(
        'base64'
      )}`;
    this.json.buffers = [
      { uri: uri ?? base64(), byteLength: this.data.byteLength },
      ...(this.json.buffers ?? []).slice(1),
    ];
    return JSON.stringify(this.json);
  }
}
