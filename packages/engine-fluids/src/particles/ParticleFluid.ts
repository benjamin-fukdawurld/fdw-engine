import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import { ComputeRunner } from '@fdw/engine-core';
import type { FluidBodies } from '../bodies';
import { compileFluid, FluidProgram, recordFluid, writeData } from '../buffers';
import { particleBlock, ParticleParameters, ParticleState } from './cpu';
import {
  cellRangesGraph,
  clearCellsGraph,
  columnsGraph,
  deltaGraph,
  keysGraph,
  lambdaGraph,
  particleWorkgroup,
  predictGraph,
  reorderGraph,
  sortGraph,
  velocityGraph,
  viscosityGraph,
} from './graphs';
import { bitonicStages, ParticleLayout, particleLayout } from './kernels';

/** The options of a {@link ParticleFluid}. */
export interface ParticleFluidOptions extends Partial<ParticleParameters> {
  /** The particles it can hold: a power of two (16384). */
  readonly count?: number;
  /** The radius of a particle, in meters (0.05): the spacing at rest is twice it. */
  readonly radius?: number;
  /** The box the particles stay in (its walls hold them). */
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** The steps of a frame (2). */
  readonly substeps?: number;
  /** The relaxation of the constraints, against their gradients at rest (0.05). */
  readonly relaxation?: number;
  /** Reads the surface of the liquid back from the GPU after each update, for what floats (true). */
  readonly readback?: boolean;
}

/**
 * A liquid of particles simulated on the GPU (position-based fluids,
 * Macklin and Müller 2013): each step predicts where the particles go,
 * sorts them by cell (a bitonic sort, without atomics) to find their
 * neighbors, then moves them until the density is the same everywhere,
 * in a few iterations; the velocities follow from the motion, smoothed by
 * a viscosity. Large steps stay stable. In compute graphs, on every
 * backend (WebGL2 runs them by rendering to textures: slower, for fewer
 * particles). The bodies of a {@link FluidBodies} push the particles away;
 * the surface of the liquid over each column, read back a frame late,
 * carries them ({@link ParticleFluid.heightAt}, for a `Buoyancy`). Drawn by
 * a {@link ParticleFluidRenderer}.
 *
 * @example
 * ```ts
 * const liquid = new ParticleFluid(backend, {
 *   count: 16384,
 *   radius: 0.04,
 *   bounds: { min: [-1, 0, -0.5], max: [1, 1.5, 0.5] },
 * });
 * liquid.addBlock([-1, 0, -0.5], [-0.3, 1, 0.5]);
 * // Each frame:
 * bodies.update();
 * liquid.update(dt, bodies);
 * ```
 */
export class ParticleFluid {
  readonly layout: ParticleLayout;
  readonly parameters: ParticleParameters;
  readonly substeps: number;
  /** The surface over each column of cells (vec4: height, velocity x, z, found). */
  readonly columns: GpuBuffer;

  private readonly _backend: RenderBackend;
  private readonly _runner: ComputeRunner;
  private readonly _programs: Record<
    | 'predict'
    | 'keys'
    | 'sort'
    | 'clearCells'
    | 'cellRanges'
    | 'reorder'
    | 'lambda'
    | 'delta'
    | 'velocity'
    | 'viscosity'
    | 'columns',
    FluidProgram
  >;
  private readonly _positions: [GpuBuffer, GpuBuffer];
  private readonly _velocities: [GpuBuffer, GpuBuffer];
  private readonly _predicted: [GpuBuffer, GpuBuffer];
  private readonly _entries: [GpuBuffer, GpuBuffer];
  private readonly _starts: GpuBuffer;
  private readonly _ends: GpuBuffer;
  private readonly _lambdas: GpuBuffer;
  private readonly _stages: GpuBuffer[];
  private readonly _noBodies: GpuBuffer;
  private _position = 0;
  private _velocity = 0;
  private _active = 0;
  private readonly _readback: boolean;
  private _reading = false;
  private _destroyed = false;
  private _columns?: Float32Array;

  constructor(backend: RenderBackend, options: ParticleFluidOptions) {
    if (backend.capabilities?.compute === false) {
      throw new Error('The particles need a backend with compute');
    }
    this._backend = backend;
    this.layout = particleLayout({
      count: options.count ?? 16384,
      radius: options.radius ?? 0.05,
      min: options.bounds.min,
      max: options.bounds.max,
      ...(options.relaxation !== undefined
        ? { relaxation: options.relaxation }
        : {}),
    });
    this.parameters = {
      gravity: options.gravity ?? 9.81,
      iterations: options.iterations ?? 4,
      viscosity: options.viscosity ?? 0.02,
      tensile: options.tensile ?? 0.03,
      maxSpeed: options.maxSpeed ?? 8,
    };
    this.substeps = options.substeps ?? 2;
    this._readback = options.readback ?? true;
    const { count, cells } = this.layout;
    const buffer = (label: string, size: number) =>
      backend.buffers.create({
        label: `particles ${label}`,
        size,
        usage: ['storage', 'copy-src', 'copy-dst'],
        initialData: new Float32Array(size / 4),
      });
    const pair = (label: string): [GpuBuffer, GpuBuffer] => [
      buffer(label, count * 16),
      buffer(`${label} 2`, count * 16),
    ];
    this._positions = pair('positions');
    this._velocities = pair('velocities');
    this._predicted = pair('predicted');
    this._entries = pair('entries');
    const cellCount = cells[0] * cells[1] * cells[2];
    this._starts = buffer('cell starts', cellCount * 16);
    this._ends = buffer('cell ends', cellCount * 16);
    this._lambdas = buffer('lambdas', count * 16);
    this.columns = buffer('columns', cells[0] * cells[2] * 16);
    // A buffer per stage of the sort: every dispatch binds its own.
    this._stages = bitonicStages(count).map(([j, k], s) =>
      backend.buffers.create({
        label: `particles sort stage ${s}`,
        size: 16,
        usage: ['storage'],
        initialData: new Uint32Array([j, k, 0, 0]),
      }),
    );
    this._noBodies = backend.buffers.create({
      label: 'particles no bodies',
      size: 16,
      usage: ['storage'],
    });
    const layout = this.layout;
    this._programs = {
      predict: compileFluid(predictGraph(layout), backend.capabilities),
      keys: compileFluid(keysGraph(layout), backend.capabilities),
      sort: compileFluid(sortGraph(layout), backend.capabilities),
      clearCells: compileFluid(clearCellsGraph(layout), backend.capabilities),
      cellRanges: compileFluid(cellRangesGraph(layout), backend.capabilities),
      reorder: compileFluid(reorderGraph(layout), backend.capabilities),
      lambda: compileFluid(lambdaGraph(layout), backend.capabilities),
      delta: compileFluid(deltaGraph(layout), backend.capabilities),
      velocity: compileFluid(velocityGraph(layout), backend.capabilities),
      viscosity: compileFluid(viscosityGraph(layout), backend.capabilities),
      columns: compileFluid(columnsGraph(layout), backend.capabilities),
    };
    // The bind groups of a step: the stages of the sort, and the rest.
    this._runner = new ComputeRunner(backend, {
      bindGroups: this._stages.length * 2 + 64,
    });
  }

  /** The particles in use. */
  get active(): number {
    return this._active;
  }

  /** The positions of the particles (vec4: xyz, 0), the first {@link ParticleFluid.active} in use. */
  get positions(): GpuBuffer {
    return this._positions[this._position];
  }

  /** The velocities of the particles (vec4: xyz, 0). */
  get velocities(): GpuBuffer {
    return this._velocities[this._velocity];
  }

  /**
   * Adds particles at positions (x, y, z, 0 each), all at a velocity:
   * those beyond the capacity are left out. Returns how many were added.
   */
  add(
    positions: Float32Array,
    velocity: readonly [number, number, number] = [0, 0, 0],
  ): number {
    const added = Math.min(
      positions.length / 4,
      this.layout.count - this._active,
    );
    if (added <= 0) {
      return 0;
    }
    const velocities = new Float32Array(added * 4);
    for (let i = 0; i < added; i++) {
      velocities.set([...velocity, 0], i * 4);
    }
    const offset = this._active * 16;
    writeData(this.positions, positions.subarray(0, added * 4), offset);
    writeData(this.velocities, velocities, offset);
    this._active += added;
    return added;
  }

  /** Fills a box with particles at rest spacing (up to the capacity); returns how many were added. */
  addBlock(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
    velocity: readonly [number, number, number] = [0, 0, 0],
  ): number {
    return this.add(
      particleBlock(this.layout, min, max, this.layout.count - this._active),
      velocity,
    );
  }

  /** Removes all the particles. */
  clear(): void {
    this._active = 0;
    this._columns = undefined;
  }

  /**
   * Runs the liquid for `dt` seconds on the GPU, in {@link ParticleFluid.substeps}
   * steps, then the surface of its columns. Submitted at once; then reads
   * the columns back, when the last read is done.
   */
  update(dt: number, bodies?: FluidBodies): void {
    if (dt <= 0 || this._active === 0) {
      return;
    }
    const step = dt / this.substeps;
    const { count, cells } = this.layout;
    const particles = [Math.ceil(count / particleWorkgroup)] as const;
    const cellGroups = [
      Math.ceil((cells[0] * cells[1] * cells[2]) / particleWorkgroup),
    ] as const;
    const encoder = this._backend.createCommandEncoder();
    const dispatch = (
      program: FluidProgram,
      workgroups: readonly [number],
      values: Record<string, GpuBuffer | number>,
    ) => {
      // A pass per dispatch: each one reads what the last one wrote.
      const pass = encoder.beginComputePass(program.program.name);
      recordFluid(this._runner, pass, program, values, workgroups);
      pass.end();
    };
    const p = this.parameters;
    const bodyValues = {
      bodies: bodies && bodies.count > 0 ? bodies.buffer : this._noBodies,
      bodyCount: bodies?.count ?? 0,
    };
    const active = this._active;
    for (let s = 0; s < this.substeps; s++) {
      const position = this._position;
      const velocity = this._velocity;
      dispatch(this._programs.predict, particles, {
        positions: this._positions[position],
        velocities: this._velocities[velocity],
        predicted: this._predicted[0],
        dt: step,
        gravity: p.gravity,
        active,
        ...bodyValues,
      });
      dispatch(this._programs.keys, particles, {
        predicted: this._predicted[0],
        entries: this._entries[0],
        active,
      });
      let entries = 0;
      for (const stage of this._stages) {
        dispatch(this._programs.sort, particles, {
          stage,
          entries: this._entries[entries],
          sorted: this._entries[1 - entries],
        });
        entries = 1 - entries;
      }
      const ranges = { cellStarts: this._starts, cellEnds: this._ends };
      dispatch(this._programs.clearCells, cellGroups, ranges);
      dispatch(this._programs.cellRanges, particles, {
        entries: this._entries[entries],
        ...ranges,
      });
      // In the order of the cells: the positions and velocities in the
      // other buffers, the predictions in the second.
      dispatch(this._programs.reorder, particles, {
        entries: this._entries[entries],
        positions: this._positions[position],
        velocities: this._velocities[velocity],
        predicted: this._predicted[0],
        sortedPositions: this._positions[1 - position],
        sortedVelocities: this._velocities[1 - velocity],
        sortedPredicted: this._predicted[1],
      });
      const sortedPosition = 1 - position;
      const sortedVelocity = 1 - velocity;
      let predicted = 1;
      for (let i = 0; i < p.iterations; i++) {
        dispatch(this._programs.lambda, particles, {
          predicted: this._predicted[predicted],
          lambdas: this._lambdas,
          active,
          ...ranges,
        });
        dispatch(this._programs.delta, particles, {
          predicted: this._predicted[predicted],
          lambdas: this._lambdas,
          nextPredicted: this._predicted[1 - predicted],
          tensile: p.tensile,
          active,
          ...ranges,
          ...bodyValues,
        });
        predicted = 1 - predicted;
      }
      dispatch(this._programs.velocity, particles, {
        positions: this._positions[sortedPosition],
        predicted: this._predicted[predicted],
        velocities: this._velocities[sortedVelocity],
        nextVelocities: this._velocities[velocity],
        dt: step,
        active,
      });
      dispatch(this._programs.viscosity, particles, {
        predicted: this._predicted[predicted],
        velocities: this._velocities[velocity],
        nextVelocities: this._velocities[sortedVelocity],
        nextPositions: this._positions[position],
        viscosity: p.viscosity,
        maxSpeed: p.maxSpeed,
        active,
        ...ranges,
      });
      // The positions back in the first buffer of this step, the
      // velocities in the sorted one.
      this._velocity = sortedVelocity;
    }
    dispatch(
      this._programs.columns,
      [Math.ceil((cells[0] * cells[2]) / particleWorkgroup)],
      {
        cellStarts: this._starts,
        cellEnds: this._ends,
        positions: this.positions,
        velocities: this.velocities,
        columns: this.columns,
      },
    );
    this._backend.submit([encoder.finish()]);
    if (this._readback && !this._reading) {
      this.readColumns();
    }
  }

  /** The height of the liquid above (x, z), from its columns read back: the bottom of the box where it is dry. */
  heightAt(x: number, z: number): number {
    return this.column(x, z)?.[0] ?? this.layout.min[1];
  }

  /** The velocity of the liquid at the surface above (x, z), in m/s. */
  velocityAt(
    x: number,
    z: number,
    out: { x: number; z: number } = { x: 0, z: 0 },
  ): { x: number; z: number } {
    const column = this.column(x, z);
    out.x = column?.[1] ?? 0;
    out.z = column?.[2] ?? 0;
    return out;
  }

  /** Reads the positions and velocities back from the GPU (the state of the CPU steps). */
  async read(): Promise<ParticleState> {
    const [positions, velocities] = await Promise.all([
      this.positions.read(),
      this.velocities.read(),
    ]);
    return {
      layout: this.layout,
      positions: new Float32Array(positions),
      velocities: new Float32Array(velocities),
      active: this._active,
    };
  }

  destroy(): void {
    this._destroyed = true;
    this._runner.destroy();
    for (const buffer of [
      ...this._positions,
      ...this._velocities,
      ...this._predicted,
      ...this._entries,
      this._starts,
      this._ends,
      this._lambdas,
      this.columns,
      ...this._stages,
      this._noBodies,
    ]) {
      buffer.destroy();
    }
  }

  // The column under (x, z), if it holds liquid.
  private column(x: number, z: number): Float32Array | undefined {
    const columns = this._columns;
    if (!columns) {
      return undefined;
    }
    const { min, h, cells } = this.layout;
    const i = Math.floor((x - min[0]) / h);
    const k = Math.floor((z - min[2]) / h);
    if (i < 0 || k < 0 || i >= cells[0] || k >= cells[2]) {
      return undefined;
    }
    const at = (k * cells[0] + i) * 4;
    return columns[at + 3] > 0.5 ? columns.subarray(at, at + 4) : undefined;
  }

  private readColumns(): void {
    this._reading = true;
    this.columns
      .read()
      .then((data) => {
        this._reading = false;
        if (!this._destroyed) {
          this._columns = new Float32Array(data);
        }
      })
      .catch(() => {
        this._reading = false;
      });
  }
}
