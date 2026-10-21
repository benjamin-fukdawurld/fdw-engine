// The inverse fast Fourier transform of the ocean, the same on the CPU and
// on the GPU: a radix-2 decimation in time, out of place, one pass per
// stage. Each stage is a table of butterflies, one per point:
// out[i] = in[a] + w × in[b], the first stage reading its input in
// bit-reversed order. The GPU reads the tables from storage buffers; the
// CPU runs them here, for the tests and the physics without a GPU.

/** Whether n is a power of 2, from 2 up. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

/** The bits of i, reversed over `bits` bits. */
export function reverseBits(i: number, bits: number): number {
  let reversed = 0;
  for (let b = 0; b < bits; b++) {
    reversed = (reversed << 1) | ((i >> b) & 1);
  }
  return reversed;
}

/**
 * The butterflies of an inverse FFT of n points (a power of 2), stage by
 * stage: for each point i, 4 floats (a, b, the real and imaginary parts of
 * w), such that out[i] = in[a] + w × in[b]. The first stage reads the
 * input in bit-reversed order: its a and b are reversed.
 */
export function butterflyTables(n: number): Float32Array<ArrayBuffer>[] {
  if (!isPowerOfTwo(n)) {
    throw new Error(`The FFT needs a power of 2 points, not ${n}`);
  }
  const stages = Math.log2(n);
  const tables: Float32Array<ArrayBuffer>[] = [];
  for (let s = 0; s < stages; s++) {
    const table = new Float32Array(n * 4);
    const span = 2 << s;
    const half = span >> 1;
    for (let i = 0; i < n; i++) {
      const j = i % span;
      const start = i - j;
      // The top half adds w^k × the odd term, the bottom half subtracts it.
      const top = j < half;
      const k = top ? j : j - half;
      let a = start + k;
      let b = a + half;
      if (s === 0) {
        a = reverseBits(a, stages);
        b = reverseBits(b, stages);
      }
      // e^(+2πik/span): the inverse transform.
      const angle = (2 * Math.PI * k) / span;
      const sign = top ? 1 : -1;
      table.set([a, b, sign * Math.cos(angle), sign * Math.sin(angle)], i * 4);
    }
    tables.push(table);
  }
  return tables;
}

/**
 * The inverse FFT of the rows, then of the columns, of square grids of n × n
 * complex values, interleaved (re, im), row after row, grid after grid: in
 * place, by the tables of {@link butterflyTables}. Without the 1/n² of the
 * inverse transform: a sum of waves.
 */
export function inverseFft2d(
  data: Float64Array,
  n: number,
  tables: readonly Float32Array[] = butterflyTables(n),
): Float64Array {
  const grids = data.length / (2 * n * n);
  let from: Float64Array = data;
  let to: Float64Array = new Float64Array(data.length);
  // A pass of a stage along the rows (step 1) or the columns (step n).
  const pass = (table: Float32Array, rows: boolean) => {
    for (let grid = 0; grid < grids; grid++) {
      const base = grid * n * n;
      for (let line = 0; line < n; line++) {
        for (let i = 0; i < n; i++) {
          const a = table[i * 4];
          const b = table[i * 4 + 1];
          const wr = table[i * 4 + 2];
          const wi = table[i * 4 + 3];
          const at = (k: number) =>
            2 * (base + (rows ? line * n + k : k * n + line));
          const ia = at(a);
          const ib = at(b);
          const br = from[ib];
          const bi = from[ib + 1];
          const out = at(i);
          to[out] = from[ia] + wr * br - wi * bi;
          to[out + 1] = from[ia + 1] + wr * bi + wi * br;
        }
      }
    }
    [from, to] = [to, from];
  };
  for (const rows of [true, false]) {
    for (const table of tables) {
      pass(table, rows);
    }
  }
  if (from !== data) {
    data.set(from);
  }
  return data;
}
