const floats = new Float32Array(1);
const bits = new Uint32Array(floats.buffer);

/** The IEEE half float of a number, rounded to nearest; infinities and NaN kept. */
export function toHalf(value: number): number {
  floats[0] = value;
  const x = bits[0];
  const sign = (x >>> 16) & 0x8000;
  const exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  let e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // too large: infinity
  if (e <= 0) {
    // A subnormal half, or zero.
    if (e < -10) return sign;
    mantissa = (mantissa | 0x800000) >> (1 - e);
    return sign | ((mantissa + 0x1000) >> 13);
  }
  const half = sign | (e << 10) | (mantissa >> 13);
  // Round to nearest: the carry may move to the exponent, which is right.
  return mantissa & 0x1000 ? half + 1 : half;
}

/** Half floats of every value: HDR pixels for `rgba16float`. */
export function toHalfFloats(values: Float32Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = toHalf(values[i]);
  return out;
}
