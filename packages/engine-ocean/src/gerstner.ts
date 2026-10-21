import { clearSample, heightAbove, waveSample, WaveSample } from './sample';

/** A Gerstner wave: a train of parallel crests. */
export interface GerstnerWave {
  /** The direction it travels to, in radians from +x toward +z. */
  readonly direction: number;
  /** The distance between two crests, in meters. */
  readonly wavelength: number;
  /** Half the height from trough to crest, in meters. */
  readonly amplitude: number;
  /**
   * How sharp its crests are, from 0 (a sine) to 1 (the crests of all the
   * waves pinched to a point when they meet): the water moves in circles
   * of radius steepness / (k × count). Default 0.5.
   */
  readonly steepness?: number;
  /** Its phase at time 0, in radians. */
  readonly phase?: number;
}

/** The constants of a Gerstner wave, computed once. */
export interface GerstnerConstants {
  readonly dx: number;
  readonly dz: number;
  /** The wave number 2π / wavelength. */
  readonly k: number;
  /** The angular frequency, √(g k) in deep water. */
  readonly omega: number;
  readonly amplitude: number;
  /** The radius of the horizontal motion. */
  readonly horizontal: number;
  readonly phase: number;
}

/**
 * Sums of Gerstner waves (Gerstner 1802; Fournier and Reeves 1986): each
 * point of the surface moves on a circle, the crests sharpen and the
 * troughs widen. Evaluated exactly on the CPU (for the physics) and in the
 * vertex shader, on every backend.
 */
export class GerstnerWaves {
  readonly waves: readonly GerstnerWave[];
  private readonly _constants: readonly GerstnerConstants[];
  private readonly _sample = waveSample();
  private _time = 0;

  constructor(waves: readonly GerstnerWave[], { gravity = 9.81 } = {}) {
    if (waves.length === 0) {
      throw new Error('Gerstner waves need at least one wave');
    }
    this.waves = waves;
    this._constants = waves.map((wave) => {
      if (!(wave.wavelength > 0)) {
        throw new Error(`A wave length must be positive: ${wave.wavelength}`);
      }
      const k = (2 * Math.PI) / wave.wavelength;
      return {
        dx: Math.cos(wave.direction),
        dz: Math.sin(wave.direction),
        k,
        omega: Math.sqrt(gravity * k),
        amplitude: wave.amplitude,
        horizontal: (wave.steepness ?? 0.5) / (k * waves.length),
        phase: wave.phase ?? 0,
      };
    });
  }

  /** The time of the waves, in seconds. */
  get time(): number {
    return this._time;
  }

  update(time: number): void {
    this._time = time;
  }

  /** The highest crest, and the farthest horizontal motion, in meters. */
  get maxHeight(): number {
    return this._constants.reduce((sum, wave) => sum + wave.amplitude, 0);
  }

  get maxHorizontal(): number {
    return this._constants.reduce((sum, wave) => sum + wave.horizontal, 0);
  }

  /**
   * The phase of each wave at the time of the waves, phase - ωt wrapped to
   * [0, 2π): what the shaders add to k (d · x), exact at any time.
   */
  phases(time = this._time): number[] {
    return this._constants.map((wave) => {
      const phase = (wave.phase - wave.omega * time) % (2 * Math.PI);
      return phase < 0 ? phase + 2 * Math.PI : phase;
    });
  }

  /** The constants of the waves: direction, wave number, amplitudes. */
  get constants(): readonly GerstnerConstants[] {
    return this._constants;
  }

  /** The water at a point (x, z) of the still surface, at the time of the waves. */
  sample(x: number, z: number, out: WaveSample = waveSample()): WaveSample {
    clearSample(out);
    const phases = this.phases();
    this._constants.forEach((wave, i) => {
      const theta = wave.k * (wave.dx * x + wave.dz * z) + phases[i];
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const q = wave.horizontal;
      out.dx += q * wave.dx * cos;
      out.dz += q * wave.dz * cos;
      out.h += wave.amplitude * sin;
      const ak = wave.amplitude * wave.k * cos;
      out.dhdx += ak * wave.dx;
      out.dhdz += ak * wave.dz;
      const qk = q * wave.k * sin;
      out.dxdx -= qk * wave.dx * wave.dx;
      out.dzdz -= qk * wave.dz * wave.dz;
      out.dxdz -= qk * wave.dx * wave.dz;
    });
    return out;
  }

  /** The height of the water above (x, z), relative to the level of the sea. */
  heightAt(x: number, z: number): number {
    return heightAbove(
      (px, pz, out) => this.sample(px, pz, out),
      x,
      z,
      this._sample,
    );
  }
}
