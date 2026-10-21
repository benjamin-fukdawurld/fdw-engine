import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import { ComputeRunner } from '@fdw/engine-core';
import { compile } from '@fdw/engine-shader';
import type { CompiledProgram } from '@fdw/engine-shader';
import { butterflyTables } from './fft';
import {
  evaluateSpectrum,
  loopTime,
  OceanFields,
  sampleFields,
} from './fields';
import { butterflyGraph, resolveGraph, spectrumGraph } from './graphs';
import { heightAbove, waveSample, WaveSample } from './sample';
import { createSpectrum, SpectrumData, SpectrumOptions } from './spectrum';

/** The options of an {@link OceanSpectrum}: its sea, and how it moves. */
export interface OceanSpectrumOptions extends SpectrumOptions {
  /**
   * Scales the horizontal motion of the water, which sharpens the crests:
   * 0 for round waves, 1 (the default) for the motion of the spectrum.
   */
  readonly choppiness?: number;
  /**
   * Reads the heights back from the GPU after each update, for
   * {@link OceanSpectrum.heightAt} (the physics): one frame late. Default
   * true.
   */
  readonly readback?: boolean;
}

/**
 * The ocean of Tessendorf on the GPU: a spectrum of waves (JONSWAP or
 * Phillips) brought to the heights, motions and slopes of the sea by
 * inverse FFTs, in compute graphs, on every backend (WebGL2 runs them by
 * rendering to textures). Several cascades, tiles of different sizes,
 * hide the repetition. The fields stay on the GPU, in two storage buffers
 * read by the material of the {@link Ocean}; the heights come back to the
 * CPU one frame late, for what floats.
 *
 * @example
 * ```ts
 * const waves = new OceanSpectrum(backend, { windSpeed: 10 });
 * // Each frame, before rendering:
 * waves.update(time);
 * ```
 */
export class OceanSpectrum {
  readonly kind = 'spectrum';
  readonly data: SpectrumData;
  readonly choppiness: number;
  /** dx, h, dz, ∂dx/∂z of every point of the grids (vec4). */
  readonly displacement: GpuBuffer;
  /** ∂h/∂x, ∂h/∂z, ∂dx/∂x, ∂dz/∂z of every point of the grids (vec4). */
  readonly derivatives: GpuBuffer;

  private readonly _backend: RenderBackend;
  private readonly _runner: ComputeRunner;
  private readonly _programs: {
    spectrum: CompiledProgram;
    rows: CompiledProgram;
    columns: CompiledProgram;
    resolve: CompiledProgram;
  };
  private readonly _amplitudes: GpuBuffer;
  private readonly _waves: GpuBuffer;
  private readonly _butterflies: GpuBuffer[];
  // The two sets of fields the stages of the FFT go back and forth between.
  private readonly _fields: [GpuBuffer, GpuBuffer][];
  private readonly _readback: boolean;
  private _reading = false;
  private _time = 0;
  // The heights on the CPU: read back, or computed until the first read.
  private _cpu?: OceanFields;
  private _cpuTime = 0;
  private readonly _zeros: Float32Array;
  private readonly _sample = waveSample();
  private _destroyed = false;

  constructor(backend: RenderBackend, options: OceanSpectrumOptions = {}) {
    if (backend.capabilities?.compute === false) {
      throw new Error('The ocean spectrum needs a backend with compute');
    }
    this._backend = backend;
    this.data = createSpectrum(options);
    this.choppiness = options.choppiness ?? 1;
    this._readback = options.readback ?? true;
    const { resolution: n, cascades } = this.data;
    const bytes = cascades.length * n * n * 16;
    this._zeros = new Float32Array(cascades.length * n * n * 4);
    const buffer = (label: string, data?: Float32Array<ArrayBuffer>) =>
      backend.buffers.create({
        label: `ocean ${label}`,
        size: bytes,
        usage: ['storage', 'copy-src', 'copy-dst'],
        ...(data ? { initialData: data } : {}),
      });
    this._amplitudes = buffer('amplitudes', this.data.amplitudes);
    this._waves = buffer('waves', this.data.waves);
    this._fields = [
      [buffer('fields A'), buffer('fields B')],
      [buffer('fields A2'), buffer('fields B2')],
    ];
    this.displacement = buffer('displacement');
    this.derivatives = buffer('derivatives');
    // A buffer per stage: every dispatch binds its own resources.
    this._butterflies = butterflyTables(n).map((table, stage) =>
      backend.buffers.create({
        label: `ocean butterflies ${stage}`,
        size: table.byteLength,
        usage: ['storage', 'copy-dst'],
        initialData: table,
      }),
    );
    const capabilities = { capabilities: backend.capabilities };
    this._programs = {
      spectrum: compile(spectrumGraph(n), capabilities),
      rows: compile(butterflyGraph(n, 'rows'), capabilities),
      columns: compile(butterflyGraph(n, 'columns'), capabilities),
      resolve: compile(resolveGraph(n), capabilities),
    };
    this._runner = new ComputeRunner(backend);
  }

  /** The time of the waves, in seconds. */
  get time(): number {
    return this._time;
  }

  /** About the highest crest (4 standard deviations of the heights), in meters. */
  get maxHeight(): number {
    return 4 * this.data.heightDeviation;
  }

  /** About the farthest horizontal motion, in meters. */
  get maxHorizontal(): number {
    return 4 * this.data.heightDeviation * this.choppiness;
  }

  /**
   * Computes the sea at a time, on the GPU: the spectrum, the stages of the
   * FFT along the rows then the columns, the fields. Submitted at once,
   * before the frame that draws the sea. Then reads the heights back, when
   * the last read is done.
   */
  update(time: number): void {
    this._time = time;
    const { resolution: n, cascades } = this.data;
    const workgroups = [n / 8, n / 8, cascades.length] as const;
    const encoder = this._backend.createCommandEncoder();
    const dispatch = (
      program: CompiledProgram,
      values: Record<string, GpuBuffer | number>,
    ) => {
      // A pass per dispatch: each one reads what the last one wrote.
      const pass = encoder.beginComputePass(program.name);
      this._runner.record(pass, program, { values, workgroups });
      pass.end();
    };
    let [from, to] = this._fields;
    dispatch(this._programs.spectrum, {
      amplitudes: this._amplitudes,
      waves: this._waves,
      time: loopTime(time, this.data.period),
      fieldsA: from[0],
      fieldsB: from[1],
    });
    for (const program of [this._programs.rows, this._programs.columns]) {
      for (const butterflies of this._butterflies) {
        dispatch(program, {
          butterflies,
          inputA: from[0],
          inputB: from[1],
          outputA: to[0],
          outputB: to[1],
        });
        [from, to] = [to, from];
      }
    }
    dispatch(this._programs.resolve, {
      inputA: from[0],
      inputB: from[1],
      displacement: this.displacement,
      derivatives: this.derivatives,
      choppiness: this.choppiness,
    });
    this._backend.submit([encoder.finish()]);
    if (this._readback && !this._reading) {
      this.read(time);
    }
  }

  // Reads the displacement back; the heights of the CPU take it when done.
  private read(time: number): void {
    this._reading = true;
    this.displacement
      .read()
      .then((data) => {
        this._reading = false;
        if (this._destroyed) {
          return;
        }
        this._cpu = {
          resolution: this.data.resolution,
          cascades: this.data.cascades,
          displacement: new Float32Array(data),
          // The derivatives stay on the GPU.
          derivatives: this._zeros,
        };
        this._cpuTime = time;
      })
      .catch(() => {
        this._reading = false;
      });
  }

  /**
   * The fields of the sea on the CPU: the last ones read back, or, before
   * the first read (or without readback), computed by the FFT of the CPU at
   * the time of the waves.
   */
  get fields(): OceanFields {
    if (!this._cpu || (!this._readback && this._cpuTime !== this._time)) {
      this._cpu = evaluateSpectrum(this.data, this._time, this.choppiness);
      this._cpuTime = this._time;
    }
    return this._cpu;
  }

  /** The time of the fields of the CPU: a frame late with the readback. */
  get fieldsTime(): number {
    return this._cpuTime;
  }

  /** The water at a point (x, z) of the still surface, from the fields of the CPU. */
  sample(x: number, z: number, out: WaveSample = waveSample()): WaveSample {
    return sampleFields(this.fields, x, z, out);
  }

  /** The height of the water above (x, z), relative to the level of the sea. */
  heightAt(x: number, z: number): number {
    const fields = this.fields;
    return heightAbove(
      (px, pz, out) => sampleFields(fields, px, pz, out),
      x,
      z,
      this._sample,
    );
  }

  destroy(): void {
    this._destroyed = true;
    this._runner.destroy();
    for (const buffer of [
      this._amplitudes,
      this._waves,
      ...this._fields.flat(),
      ...this._butterflies,
      this.displacement,
      this.derivatives,
    ]) {
      buffer.destroy();
    }
  }
}
