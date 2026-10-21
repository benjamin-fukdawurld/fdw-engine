import { butterflyTables, inverseFft2d } from './fft';
import { clearSample, WaveSample } from './sample';
import type { SpectrumData } from './spectrum';

/**
 * The sea of a spectrum at a time, on the grids of its cascades: what the
 * GPU computes, in the same layout (cascade, row along z, column along x;
 * 4 floats per point).
 */
export interface OceanFields {
  readonly resolution: number;
  readonly cascades: readonly number[];
  /** dx, h, dz, ∂dx/∂z. */
  readonly displacement: Float32Array;
  /** ∂h/∂x, ∂h/∂z, ∂dx/∂x, ∂dz/∂z. */
  readonly derivatives: Float32Array;
}

/** The time of the spectrum within its period: the phases are exact. */
export const loopTime = (time: number, period: number) =>
  ((time % period) + period) % period;

/**
 * The spectrum at a time, then the eight fields of the sea by inverse FFT,
 * as the GPU does it: the spectra of two real fields packed in one complex
 * field (a + ib), four complex fields. `choppiness` scales the horizontal
 * motion (and its derivatives).
 */
export function evaluateSpectrum(
  data: SpectrumData,
  time: number,
  choppiness = 1,
): OceanFields {
  const n = data.resolution;
  const count = data.cascades.length * n * n;
  // The four complex fields, each in its own grids.
  const fields = Array.from({ length: 4 }, () => new Float64Array(count * 2));
  const t = loopTime(time, data.period);
  const { amplitudes, waves } = data;
  for (let i = 0; i < count; i++) {
    const [ar, ai, br, bi] = amplitudes.subarray(i * 4, i * 4 + 4);
    const [kx, kz, omega, inverse] = waves.subarray(i * 4, i * 4 + 4);
    const c = Math.cos(omega * t);
    const s = Math.sin(omega * t);
    // h = h0 e^(iωt) + conj(h0(-k)) e^(-iωt).
    const hr = ar * c - ai * s + br * c + bi * s;
    const hi = ar * s + ai * c + bi * c - br * s;
    // i × (re, im) = (-im, re).
    const pack = (field: number, a: [number, number], b: [number, number]) => {
      fields[field][i * 2] = a[0] - b[1];
      fields[field][i * 2 + 1] = a[1] + b[0];
    };
    const scaled = (factor: number): [number, number] => [
      hr * factor,
      hi * factor,
    ];
    // -i kx/k h, -i kz/k h.
    const dx: [number, number] = [hi * kx * inverse, -hr * kx * inverse];
    const dz: [number, number] = [hi * kz * inverse, -hr * kz * inverse];
    // i kx h, i kz h.
    const dhdx: [number, number] = [-hi * kx, hr * kx];
    const dhdz: [number, number] = [-hi * kz, hr * kz];
    pack(0, dx, dz);
    pack(1, [hr, hi], scaled(kx * kz * inverse));
    pack(2, dhdx, dhdz);
    pack(3, scaled(kx * kx * inverse), scaled(kz * kz * inverse));
  }
  const tables = butterflyTables(n);
  for (const field of fields) {
    inverseFft2d(field, n, tables);
  }
  const displacement = new Float32Array(count * 4);
  const derivatives = new Float32Array(count * 4);
  const λ = choppiness;
  for (let i = 0; i < count; i++) {
    const column = i % n;
    const row = Math.floor(i / n) % n;
    // The waves are centered on k = 0: (-1)^(row + column).
    const sign = (row + column) % 2 === 0 ? 1 : -1;
    const re = (field: number) => fields[field][i * 2] * sign;
    const im = (field: number) => fields[field][i * 2 + 1] * sign;
    displacement.set([λ * re(0), re(1), λ * im(0), λ * im(1)], i * 4);
    derivatives.set([re(2), im(2), λ * re(3), λ * im(3)], i * 4);
  }
  return {
    resolution: n,
    cascades: data.cascades,
    displacement,
    derivatives,
  };
}

/**
 * The sea at a point of the still surface: the sum of the cascades, each
 * read between its four nearest points (bilinear, the tiles repeating).
 */
export function sampleFields(
  fields: OceanFields,
  x: number,
  z: number,
  out: WaveSample,
): WaveSample {
  clearSample(out);
  const n = fields.resolution;
  const { displacement: d, derivatives: s } = fields;
  fields.cascades.forEach((side, c) => {
    const u = (x / side) * n;
    const v = (z / side) * n;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const at = (di: number, dj: number) =>
      ((c * n + ((j + dj) & (n - 1))) * n + ((i + di) & (n - 1))) * 4;
    const corners = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
    const weights = [
      (1 - fu) * (1 - fv),
      fu * (1 - fv),
      (1 - fu) * fv,
      fu * fv,
    ];
    for (let k = 0; k < 4; k++) {
      const p = corners[k];
      const w = weights[k];
      out.dx += d[p] * w;
      out.h += d[p + 1] * w;
      out.dz += d[p + 2] * w;
      out.dxdz += d[p + 3] * w;
      out.dhdx += s[p] * w;
      out.dhdz += s[p + 1] * w;
      out.dxdx += s[p + 2] * w;
      out.dzdz += s[p + 3] * w;
    }
  });
  return out;
}
