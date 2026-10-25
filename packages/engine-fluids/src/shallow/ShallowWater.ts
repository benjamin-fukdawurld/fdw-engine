import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import { ComputeRunner } from '@fdw/engine-core';
import type { FluidBodies } from '../bodies';
import { compileFluid, FluidProgram, recordFluid, writeData } from '../buffers';
import {
  sampleCells,
  ShallowState,
  sourceRates,
  stepShallowWater,
  WaterSource,
} from './cpu';
import {
  depthGraph,
  fluxGraph,
  ShallowGrid,
  surfaceGraph,
  workgroupSize,
} from './graphs';

/** The options of a {@link ShallowWater}. */
export interface ShallowWaterOptions {
  /** The cells along x and z. */
  readonly resolution: readonly [number, number];
  /** The side of a cell, in meters (0.25). */
  readonly cell?: number;
  /** The corner of the grid in the world (x, z): the grid is centered on 0 by default. */
  readonly origin?: { readonly x: number; readonly z: number };
  /**
   * The height of the ground of each cell (row after row, along x then z),
   * a function of the world position of its center, or a single height
   * (0 by default).
   */
  readonly ground?: Float32Array | ((x: number, z: number) => number) | number;
  /** The water at the start: up to this height, where the ground is lower. */
  readonly level?: number;
  /** Whether the water leaves by the edges of the grid (rivers), or meets walls (basins). */
  readonly edges?: 'closed' | 'open';
  /** How fast the waves fade, per second (0.2). */
  readonly damping?: number;
  /**
   * How much of the water a body displaces it pushes aside: k / (k + 1)
   * (6: 86 %). Higher is stiffer, and needs shorter steps.
   */
  readonly stiffness?: number;
  /** In m/s² (9.81). */
  readonly gravity?: number;
  /**
   * The deepest water expected, in meters (2): the steps are short enough
   * for the waves on it (dt < cell / √(g × depth) / 2).
   */
  readonly maxDepth?: number;
  /** Reads the water back from the GPU after each update, for the physics (true). */
  readonly readback?: boolean;
}

/** A source added by {@link ShallowWater.addSource}: remove it to stop it. */
export interface SourceHandle extends WaterSource {
  remove(): void;
}

/**
 * Water on a ground, simulated on the GPU as a field of heights: a grid of
 * columns of water exchanging it by fluxes through virtual pipes (O'Brien
 * and Hodgins), in compute graphs, on every backend. Basins, rivers on a
 * relief, waves and ripples; the water is conserved, the cells can dry.
 * The bodies of a {@link FluidBodies} push it away; it carries them, read
 * back a frame late ({@link ShallowWater.heightAt},
 * {@link ShallowWater.velocityAt}, for a `Buoyancy`). Drawn by a
 * {@link WaterSurface}.
 *
 * @example
 * ```ts
 * const water = new ShallowWater(backend, {
 *   resolution: [128, 128],
 *   cell: 0.25,
 *   ground: (x, z) => basinFloor(x, z),
 *   level: 1,
 * });
 * // Each frame:
 * bodies.update();
 * water.update(dt, bodies);
 * ```
 */
export class ShallowWater {
  readonly grid: ShallowGrid;
  readonly gravity: number;
  readonly damping: number;
  readonly stiffness: number;
  /** The heights of the ground, as given. */
  readonly ground: Float32Array;
  /** The longest step of the simulation, in seconds. */
  readonly maxStep: number;
  /** The deepest water expected, in meters (see {@link ShallowWaterOptions.maxDepth}). */
  readonly maxDepth: number;
  /**
   * For the rendering, each cell: the height of the surface, its slopes
   * along x and z, the speed of the water (-1 where it is dry) (vec4).
   */
  readonly surface: GpuBuffer;

  private readonly _backend: RenderBackend;
  private readonly _runner: ComputeRunner;
  private readonly _programs: {
    flux: FluidProgram;
    depth: FluidProgram;
    surface: FluidProgram;
  };
  private readonly _groundBuffer: GpuBuffer;
  // The two states the steps go back and forth between.
  private readonly _cells: [GpuBuffer, GpuBuffer];
  private readonly _flux: [GpuBuffer, GpuBuffer];
  private _current = 0;
  private readonly _sources: SourceHandle[] = [];
  private readonly _sourceBuffer: GpuBuffer;
  private readonly _noBodies: GpuBuffer;
  private _splashes: WaterSource[] = [];
  private readonly _readback: boolean;
  private _reading = false;
  private _destroyed = false;
  // The cells on the CPU: the start, then the last ones read back.
  private _cpu: Float32Array<ArrayBuffer>;
  private readonly _initial: Float32Array<ArrayBuffer>;

  constructor(backend: RenderBackend, options: ShallowWaterOptions) {
    if (backend.capabilities?.compute === false) {
      throw new Error('The shallow water needs a backend with compute');
    }
    const [nx, nz] = options.resolution;
    if (!(nx >= 2 && nz >= 2)) {
      throw new Error(
        `The shallow water needs 2 × 2 cells at least: ${nx} × ${nz}`,
      );
    }
    const cell = options.cell ?? 0.25;
    this._backend = backend;
    this.grid = {
      nx,
      nz,
      cell,
      origin: options.origin ?? { x: (-nx * cell) / 2, z: (-nz * cell) / 2 },
      open: options.edges === 'open',
    };
    this.gravity = options.gravity ?? 9.81;
    this.damping = options.damping ?? 0.2;
    this.stiffness = options.stiffness ?? 6;
    this.maxDepth = Math.max(options.maxDepth ?? 2, 0.01);
    this.maxStep = cell / Math.sqrt(this.gravity * this.maxDepth) / 2;
    this._readback = options.readback ?? true;
    this.ground = groundOf(this.grid, options.ground ?? 0);
    this._initial = new Float32Array(nx * nz * 4);
    if (options.level !== undefined) {
      for (let k = 0; k < nx * nz; k++) {
        this._initial[k * 4] = Math.max(options.level - this.ground[k], 0);
      }
    }
    this._cpu = this._initial.slice();
    const bytes = nx * nz * 16;
    // Zeros by default: no backend promises it.
    const buffer = (label: string, data?: Float32Array<ArrayBuffer>) =>
      backend.buffers.create({
        label: `shallow water ${label}`,
        size: bytes,
        usage: ['storage', 'copy-src', 'copy-dst'],
        initialData: data ?? new Float32Array(bytes / 4),
      });
    this._groundBuffer = backend.buffers.create({
      label: 'shallow water ground',
      size: nx * nz * 4,
      usage: ['storage', 'copy-dst'],
      initialData: this.ground as Float32Array<ArrayBuffer>,
    });
    this._cells = [buffer('cells', this._initial), buffer('cells 2')];
    this._flux = [
      buffer('flux', new Float32Array(nx * nz * 4)),
      buffer('flux 2'),
    ];
    this.surface = buffer('surface');
    this._sourceBuffer = backend.buffers.create({
      label: 'shallow water sources',
      size: 16 * 16,
      usage: ['storage', 'copy-dst'],
    });
    this._noBodies = backend.buffers.create({
      label: 'shallow water no bodies',
      size: 16,
      usage: ['storage'],
    });
    this._programs = {
      flux: compileFluid(fluxGraph(this.grid), backend.capabilities),
      depth: compileFluid(depthGraph(this.grid), backend.capabilities),
      surface: compileFluid(surfaceGraph(this.grid), backend.capabilities),
    };
    this._runner = new ComputeRunner(backend);
    this.updateSurface();
  }

  /** The cells: depth, occupancy, velocity x, velocity z (vec4), of the last step. */
  get cells(): GpuBuffer {
    return this._cells[this._current];
  }

  /** The fluxes of the last step (vec4: toward -x, +x, -z, +z, in m³/s). */
  get flux(): GpuBuffer {
    return this._flux[this._current];
  }

  /** The sources of water (16 at most, splashes included). */
  get sources(): readonly SourceHandle[] {
    return this._sources;
  }

  /**
   * Water poured in (a positive rate, in m³/s) or drained (negative), over
   * a disc of the world: a spring, the head of a river, a sink.
   */
  addSource(source: WaterSource): SourceHandle {
    const handle: SourceHandle = {
      ...source,
      remove: () => {
        const index = this._sources.indexOf(handle);
        if (index >= 0) {
          this._sources.splice(index, 1);
        }
      },
    };
    this._sources.push(handle);
    return handle;
  }

  /**
   * Drops a volume of water (m³, negative to take it) on a disc, at the
   * next update: a splash, ripples.
   */
  splash(x: number, z: number, radius: number, volume: number): void {
    this._splashes.push({ x, z, radius, rate: volume });
  }

  /**
   * Runs the water for `dt` seconds, on the GPU: as many steps as its
   * stability asks (see {@link ShallowWater.maxStep}), each a dispatch of
   * the fluxes and one of the depths, then the surface for the rendering.
   * Submitted at once; then reads the cells back when the last read is
   * done.
   */
  update(dt: number, bodies?: FluidBodies): void {
    if (dt <= 0) {
      return;
    }
    const steps = Math.max(Math.ceil(dt / this.maxStep - 1e-9), 1);
    const step = dt / steps;
    const { nx, nz } = this.grid;
    const workgroups = [
      Math.ceil(nx / workgroupSize[0]),
      Math.ceil(nz / workgroupSize[1]),
    ] as const;
    // The splashes pour their volume during the first step.
    const sources: WaterSource[] = [...this._sources];
    const splashes = this._splashes.map((s) => ({ ...s, rate: s.rate / step }));
    this._splashes = [];
    const write = (list: readonly WaterSource[]) =>
      writeData(this._sourceBuffer, sourceRates(this.grid, list));
    if (sources.length + splashes.length > 16) {
      throw new Error(
        'The shallow water has 16 sources at most, splashes included',
      );
    }
    const bodyValues = {
      bodies: bodies && bodies.count > 0 ? bodies.buffer : this._noBodies,
      bodyCount: bodies?.count ?? 0,
    };
    const run = (count: number, withSplashes: boolean) => {
      const list = withSplashes ? [...sources, ...splashes] : sources;
      write(list);
      const encoder = this._backend.createCommandEncoder();
      for (let s = 0; s < count; s++) {
        const from = this._current;
        const to = 1 - from;
        const pass = encoder.beginComputePass('shallow water');
        recordFluid(
          this._runner,
          pass,
          this._programs.flux,
          {
            ground: this._groundBuffer,
            cells: this._cells[from],
            flux: this._flux[from],
            nextFlux: this._flux[to],
            dt: step,
            gravity: this.gravity,
            damping: this.damping,
          },
          workgroups,
        );
        pass.end();
        const depthPass = encoder.beginComputePass('shallow water depth');
        recordFluid(
          this._runner,
          depthPass,
          this._programs.depth,
          {
            ground: this._groundBuffer,
            cells: this._cells[from],
            flux: this._flux[to],
            nextCells: this._cells[to],
            sources: this._sourceBuffer,
            sourceCount: list.length,
            stiffness: this.stiffness,
            dt: step,
            ...bodyValues,
          },
          workgroups,
        );
        depthPass.end();
        this._current = to;
      }
      this._backend.submit([encoder.finish()]);
    };
    if (splashes.length > 0) {
      // A submission of its own: the source buffer changes after it.
      run(1, true);
      if (steps > 1) {
        run(steps - 1, false);
      }
    } else {
      run(steps, false);
    }
    this.updateSurface();
    if (this._readback && !this._reading) {
      this.read();
    }
  }

  /** Puts the water back as it was at the start. */
  reset(): void {
    writeData(this._cells[this._current], this._initial);
    writeData(
      this._flux[this._current],
      new Float32Array(this.grid.nx * this.grid.nz * 4),
    );
    this._cpu = this._initial.slice();
    this.updateSurface();
  }

  /**
   * The cells on the CPU: depth, occupancy, velocity x, velocity z of each
   * one, the last read back (a frame late), or the start.
   */
  get cpuCells(): Float32Array {
    return this._cpu;
  }

  /** The height of the water surface above (x, z), from the cells of the CPU. */
  heightAt(x: number, z: number): number {
    const cells = this._cpu;
    const ground = this.ground;
    return sampleCells(
      this.grid,
      x,
      z,
      (k) => ground[k] + cells[k * 4] + cells[k * 4 + 1],
    );
  }

  /** The depth of water at (x, z). */
  depthAt(x: number, z: number): number {
    const cells = this._cpu;
    return sampleCells(this.grid, x, z, (k) => cells[k * 4]);
  }

  /** The velocity of the water at (x, z), in m/s. */
  velocityAt(
    x: number,
    z: number,
    out: { x: number; z: number } = { x: 0, z: 0 },
  ): { x: number; z: number } {
    const cells = this._cpu;
    out.x = sampleCells(this.grid, x, z, (k) => cells[k * 4 + 2]);
    out.z = sampleCells(this.grid, x, z, (k) => cells[k * 4 + 3]);
    return out;
  }

  /** The state as the CPU steps take it: a copy of the cells read back. */
  cpuState(): ShallowState {
    return {
      grid: this.grid,
      ground: this.ground,
      cells: this._cpu.slice(),
      flux: new Float32Array(this._cpu.length),
    };
  }

  /** The step of the CPU (see {@link stepShallowWater}), with this water's constants. */
  stepOnCpu(state: ShallowState, dt: number, bodies?: FluidBodies): void {
    stepShallowWater(
      state,
      dt,
      {
        gravity: this.gravity,
        damping: this.damping,
        stiffness: this.stiffness,
      },
      bodies?.bodies ?? [],
      this._sources,
    );
  }

  destroy(): void {
    this._destroyed = true;
    this._runner.destroy();
    for (const buffer of [
      ...this._cells,
      ...this._flux,
      this.surface,
      this._groundBuffer,
      this._sourceBuffer,
      this._noBodies,
    ]) {
      buffer.destroy();
    }
  }

  private updateSurface(): void {
    const { nx, nz } = this.grid;
    const surface = this._programs.surface;
    this._runner.dispatch(surface.program, {
      values: {
        ...surface.defaults,
        ground: this._groundBuffer,
        cells: this._cells[this._current],
        surface: this.surface,
      },
      workgroups: [
        Math.ceil(nx / workgroupSize[0]),
        Math.ceil(nz / workgroupSize[1]),
      ],
    });
  }

  private read(): void {
    this._reading = true;
    this._cells[this._current]
      .read()
      .then((data) => {
        this._reading = false;
        if (!this._destroyed) {
          this._cpu = new Float32Array(data);
        }
      })
      .catch(() => {
        this._reading = false;
      });
  }
}

// The heights of the ground of each cell.
function groundOf(
  grid: ShallowGrid,
  ground: NonNullable<ShallowWaterOptions['ground']>,
): Float32Array {
  const { nx, nz, cell, origin } = grid;
  if (ground instanceof Float32Array) {
    if (ground.length !== nx * nz) {
      throw new Error(
        `The ground has ${ground.length} heights for ${nx} × ${nz} cells`,
      );
    }
    return ground;
  }
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      heights[j * nx + i] =
        typeof ground === 'number'
          ? ground
          : ground(origin.x + (i + 0.5) * cell, origin.z + (j + 0.5) * cell);
    }
  }
  return heights;
}
