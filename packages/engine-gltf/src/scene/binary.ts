// The typed arrays of the data of FDW_scene (a heightfield, the points of a
// collider), written in buffer views: `{ "$binary": { bufferView, type } }`.

const types = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
} as const;
type TypeName = keyof typeof types;

interface BinaryRef {
  readonly $binary: { readonly bufferView: number; readonly type: TypeName };
}

/** A copy of a value, its typed arrays written by `view` (which returns the index of a buffer view). */
export function encodeBinary(
  value: unknown,
  view: (bytes: ArrayBufferView) => number,
): unknown {
  if (ArrayBuffer.isView(value)) {
    const type = (Object.keys(types) as TypeName[]).find(
      (name) => value instanceof types[name],
    );
    if (!type) throw new Error('Unsupported typed array');
    return { $binary: { bufferView: view(value), type } };
  }
  if (Array.isArray(value)) return value.map((v) => encodeBinary(v, view));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value))
      if (v !== undefined) out[key] = encodeBinary(v, view);
    return out;
  }
  return value;
}

/** The value of encodeBinary, its typed arrays read from the buffer views. */
export async function decodeBinary(
  value: unknown,
  view: (index: number) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<unknown> {
  if (typeof value !== 'object' || value === null) return value;
  if ('$binary' in value) {
    const { bufferView, type } = (value as BinaryRef).$binary;
    const Type = types[type];
    if (!Type) throw new Error(`Unknown binary type ${type}`);
    const bytes = await view(bufferView);
    return new Type(bytes.slice().buffer);
  }
  if (Array.isArray(value))
    return Promise.all(value.map((v) => decodeBinary(v, view)));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value))
    out[key] = await decodeBinary(v, view);
  return out;
}
