import type { GltfAttributeData, GltfTypedArray } from './extension';
import {
  GltfComponentType,
  type GltfAccessor,
  type GltfAccessorType,
  type GltfBufferView,
  type GltfJson,
} from './types';

type TypedArrayConstructor = {
  new (length: number): GltfTypedArray;
  readonly BYTES_PER_ELEMENT: number;
};

const arrayTypes: Readonly<Record<number, TypedArrayConstructor>> = {
  [GltfComponentType.BYTE]: Int8Array,
  [GltfComponentType.UNSIGNED_BYTE]: Uint8Array,
  [GltfComponentType.SHORT]: Int16Array,
  [GltfComponentType.UNSIGNED_SHORT]: Uint16Array,
  [GltfComponentType.UNSIGNED_INT]: Uint32Array,
  [GltfComponentType.FLOAT]: Float32Array,
};

/** The number of values of an element of each accessor type. */
export const componentCounts: Readonly<Record<GltfAccessorType, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function arrayType(componentType: number): TypedArrayConstructor {
  const type = arrayTypes[componentType];
  if (!type)
    throw new Error(`Unknown accessor component type ${componentType}`);
  return type;
}

// Copies `count` elements of `size` bytes, `stride` bytes apart in `source`,
// tightly into `target`.
function copyElements(
  source: Uint8Array,
  offset: number,
  stride: number,
  size: number,
  count: number,
  target: Uint8Array,
) {
  if (count === 0) return;
  if (offset + (count - 1) * stride + size > source.byteLength)
    throw new Error('Accessor out of the bounds of its buffer view');
  if (stride === size) {
    target.set(source.subarray(offset, offset + count * size));
    return;
  }
  for (let i = 0; i < count; i++)
    target.set(
      source.subarray(offset + i * stride, offset + i * stride + size),
      i * size,
    );
}

/**
 * Reads the accessors of a file, each once (primitives often share their
 * positions): tightly packed copies, sparse values applied. The arrays are
 * shared between the callers, which must not modify them.
 */
export function accessorReader(
  json: GltfJson,
  bufferView: (index: number) => Promise<Uint8Array<ArrayBuffer>>,
): (index: number) => Promise<GltfAttributeData> {
  const cache = new Map<number, Promise<GltfAttributeData>>();

  const read = async (index: number): Promise<GltfAttributeData> => {
    const accessor = json.accessors?.[index];
    if (!accessor) throw new Error(`Missing accessor ${index}`);
    const type = arrayType(accessor.componentType);
    const components = componentCounts[accessor.type];
    if (!components) throw new Error(`Unknown accessor type ${accessor.type}`);
    const array = new type(accessor.count * components);
    const size = components * type.BYTES_PER_ELEMENT;
    const bytes = new Uint8Array(array.buffer);
    // Without a buffer view, the values are zeros (and sparse ones).
    if (accessor.bufferView !== undefined) {
      const stride =
        json.bufferViews?.[accessor.bufferView]?.byteStride || size;
      copyElements(
        await bufferView(accessor.bufferView),
        accessor.byteOffset ?? 0,
        stride,
        size,
        accessor.count,
        bytes,
      );
    }
    const sparse = accessor.sparse;
    if (sparse && sparse.count > 0) {
      const indexType = arrayType(sparse.indices.componentType);
      const indices = new indexType(sparse.count);
      copyElements(
        await bufferView(sparse.indices.bufferView),
        sparse.indices.byteOffset ?? 0,
        indexType.BYTES_PER_ELEMENT,
        indexType.BYTES_PER_ELEMENT,
        sparse.count,
        new Uint8Array(indices.buffer),
      );
      const values = new Uint8Array(sparse.count * size);
      copyElements(
        await bufferView(sparse.values.bufferView),
        sparse.values.byteOffset ?? 0,
        size,
        size,
        sparse.count,
        values,
      );
      for (let i = 0; i < sparse.count; i++) {
        if (indices[i] >= accessor.count)
          throw new Error(
            `Sparse index ${indices[i]} out of accessor ${index}`,
          );
        bytes.set(values.subarray(i * size, (i + 1) * size), indices[i] * size);
      }
    }
    return { array, components, normalized: accessor.normalized ?? false };
  };

  return (index) => {
    let promise = cache.get(index);
    if (!promise) cache.set(index, (promise = read(index)));
    return promise;
  };
}

/**
 * Accessors with the bytes they read, for a worker: their ranges of the
 * buffer views, copied (the file stays on this side). They keep their
 * indices; their buffer views are renumbered, one per range, into `views`.
 */
export interface PackedAccessors {
  readonly json: Pick<GltfJson, 'accessors' | 'bufferViews'>;
  readonly views: Uint8Array<ArrayBuffer>[];
}

/** Packs accessors of a file for `accessorReader` in a worker (see `PackedAccessors`). */
export async function packAccessors(
  json: GltfJson,
  indices: Iterable<number>,
  bufferView: (index: number) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<PackedAccessors> {
  const accessors: GltfAccessor[] = [];
  const bufferViews: GltfBufferView[] = [];
  const views: Uint8Array<ArrayBuffer>[] = [];
  // `count` elements of `size` bytes, `stride` apart: a range past the end
  // is cut, and fails in the worker as it would here.
  const range = async (
    index: number,
    offset: number,
    stride: number,
    size: number,
    count: number,
  ): Promise<number> => {
    const bytes = await bufferView(index);
    const end = count === 0 ? offset : offset + (count - 1) * stride + size;
    views.push(bytes.slice(offset, end));
    return (
      bufferViews.push({
        buffer: 0,
        byteLength: end - offset,
        byteStride: stride,
      }) - 1
    );
  };

  for (const index of new Set(indices)) {
    const accessor = json.accessors?.[index];
    if (!accessor) throw new Error(`Missing accessor ${index}`);
    const components = componentCounts[accessor.type];
    if (!components) throw new Error(`Unknown accessor type ${accessor.type}`);
    const size =
      components * arrayType(accessor.componentType).BYTES_PER_ELEMENT;
    let packed: GltfAccessor = { ...accessor, byteOffset: 0 };
    if (accessor.bufferView !== undefined) {
      const stride =
        json.bufferViews?.[accessor.bufferView]?.byteStride || size;
      packed = {
        ...packed,
        bufferView: await range(
          accessor.bufferView,
          accessor.byteOffset ?? 0,
          stride,
          size,
          accessor.count,
        ),
      };
    }
    const sparse = accessor.sparse;
    if (sparse && sparse.count > 0) {
      const indexSize = arrayType(
        sparse.indices.componentType,
      ).BYTES_PER_ELEMENT;
      packed = {
        ...packed,
        sparse: {
          ...sparse,
          indices: {
            ...sparse.indices,
            byteOffset: 0,
            bufferView: await range(
              sparse.indices.bufferView,
              sparse.indices.byteOffset ?? 0,
              indexSize,
              indexSize,
              sparse.count,
            ),
          },
          values: {
            ...sparse.values,
            byteOffset: 0,
            bufferView: await range(
              sparse.values.bufferView,
              sparse.values.byteOffset ?? 0,
              size,
              size,
              sparse.count,
            ),
          },
        },
      };
    }
    accessors[index] = packed;
  }
  return { json: { accessors, bufferViews }, views };
}

/** The largest value of an integer array type, the divisor of its normalized values. */
export function normalizationDivisor(array: GltfTypedArray): number {
  if (array instanceof Int8Array) return 127;
  if (array instanceof Uint8Array) return 255;
  if (array instanceof Int16Array) return 32767;
  if (array instanceof Uint16Array) return 65535;
  if (array instanceof Uint32Array) return 4294967295;
  return 1;
}

/** The values as floats, normalized integers dequantized (animations, normals). */
export function toFloat32({
  array,
  normalized,
}: GltfAttributeData): Float32Array<ArrayBuffer> {
  if (array instanceof Float32Array) return array;
  const out = new Float32Array(array.length);
  if (!normalized) {
    out.set(array);
    return out;
  }
  const divisor = normalizationDivisor(array);
  for (let i = 0; i < array.length; i++)
    out[i] = Math.max(array[i] / divisor, -1);
  return out;
}
