import type { GpuBuffer, RenderBackend } from '@fdw/engine-backend';
import { ComputeRunner } from '@fdw/engine-core';
import type { FluidBodies } from '../bodies';
import { compileFluid, FluidProgram, recordFluid, writeData } from '../buffers';
import {
  createSmokeState,
  packEmitters,
  SmokeEmitter,
  SmokeParameters,
  SmokeState,
} from './cpu';
import {
  advectScalarsGraph,
  advectVelocityGraph,
  confineGraph,
  divergenceGraph,
  GridFace,
  jacobiGraph,
  projectGraph,
  shadeGraph,
  SmokeLayout,
  solidsGraph,
  vorticityGraph,
} from './graphs';
import { faceSize, volumeWorkgroups } from './grid';

/** The options of a {@link SmokeGrid}. */
export interface SmokeGridOptions extends Partial<SmokeParameters> {
  /** The cells along x, y and z; z 1 for a grid in a plane (2D). */
  readonly resolution: readonly [number, number, number];
  /** The side of a cell, in meters (0.1). */
  readonly cell?: number;
  /** The corner of the grid in the world (its lowest x, y, z). */
  readonly origin?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /**
   * Where the smoke leaves the box: all the faces but the floor (-y) by
   * default; the others are walls.
   */
  readonly open?: readonly GridFace[];
  /** How much each meter of thick smoke dims the light (8). */
  readonly extinction?: number;
  /** The cells of the march toward the sun, for the light in the smoke (24). */
  readonly lightSteps?: number;
}

/**
 * Smoke and fire in a grid of cells, simulated on the GPU (stable fluids,
 * Stam 1999): the velocity carried along itself, the heat that lifts, the
 * swirls kept by the confinement of the vorticity, the pressure solved by
 * Jacobi steps so that the air does not compress. In compute graphs, on
 * every backend. The bodies of a {@link FluidBodies} are obstacles that
 * push the air. A grid of one cell along z is a plane (2D). Drawn by a
 * {@link SmokeRenderer}, or in a plane by `smokePlaneGraph`.
 *
 * @example
 * ```ts
 * const smoke = new SmokeGrid(backend, { resolution: [64, 96, 64], cell: 0.05 });
 * smoke.addEmitter({ x: 0, y: 0.3, z: 0, radius: 0.25, density: 2, temperature: 3 });
 * // Each frame:
 * bodies.update();
 * smoke.update(dt, bodies);
 * ```
 */
export class SmokeGrid {
  readonly layout: SmokeLayout;
  readonly parameters: SmokeParameters;
  /**
   * For the rendering, each cell: the density of smoke, the light of the
   * sun reaching it (0 to 1), the temperature (vec4).
   */
  readonly shade: GpuBuffer;
  /** The obstacles of the last update (vec4: 1 in one, its velocity). */
  readonly solids: GpuBuffer;
  /** How much each meter of thick smoke dims the light. */
  extinction: number;
  /** The cells of the march toward the sun. */
  lightSteps: number;
  /** Where the sun is, from the smoke (normalized by the graphs). */
  sunDirection: readonly [number, number, number] = [0.4, 0.8, 0.3];

  private readonly _backend: RenderBackend;
  private readonly _runner: ComputeRunner;
  private readonly _programs: Record<
    | 'solids'
    | 'advectVelocity'
    | 'advectScalars'
    | 'vorticity'
    | 'confine'
    | 'divergence'
    | 'jacobi'
    | 'project'
    | 'shade',
    FluidProgram
  >;
  private readonly _velocity: [GpuBuffer, GpuBuffer];
  private readonly _scalars: [GpuBuffer, GpuBuffer];
  private readonly _pressure: [GpuBuffer, GpuBuffer];
  private readonly _vorticity: GpuBuffer;
  private readonly _emitterBuffer: GpuBuffer;
  private readonly _noBodies: GpuBuffer;
  private _current = 0;
  private _pressureCurrent = 0;
  private readonly _emitters: SmokeEmitter[] = [];
  private _time = 0;

  constructor(backend: RenderBackend, options: SmokeGridOptions) {
    if (backend.capabilities?.compute === false) {
      throw new Error('The smoke needs a backend with compute');
    }
    const [nx, ny, nz] = options.resolution;
    if (!(nx >= 2 && ny >= 2 && nz >= 1)) {
      throw new Error(
        `The smoke needs 2 × 2 × 1 cells at least: ${nx} × ${ny} × ${nz}`,
      );
    }
    const cell = options.cell ?? 0.1;
    this._backend = backend;
    this.layout = {
      nx,
      ny,
      nz,
      cell,
      origin: options.origin ?? {
        x: (-nx * cell) / 2,
        y: 0,
        z: (-nz * cell) / 2,
      },
      open: options.open ?? ['-x', '+x', '+y', '-z', '+z'],
    };
    this.parameters = {
      buoyancy: options.buoyancy ?? 1,
      weight: options.weight ?? 0.05,
      densityDecay: options.densityDecay ?? 0.05,
      cooling: options.cooling ?? 0.8,
      vorticity: options.vorticity ?? 2,
      iterations: options.iterations ?? 20,
    };
    this.extinction = options.extinction ?? 8;
    this.lightSteps = options.lightSteps ?? 24;
    const bytes = nx * ny * nz * 16;
    const [fx, fy, fz] = faceSize(this.layout);
    // Zeros at the start: no backend promises it.
    const buffer = (label: string, size = bytes) =>
      backend.buffers.create({
        label: `smoke ${label}`,
        size,
        usage: ['storage', 'copy-src', 'copy-dst'],
        initialData: new Float32Array(size / 4),
      });
    const faces = fx * fy * fz * 16;
    this._velocity = [buffer('velocity', faces), buffer('velocity 2', faces)];
    this._scalars = [buffer('scalars'), buffer('scalars 2')];
    this._pressure = [buffer('pressure'), buffer('pressure 2')];
    this._vorticity = buffer('vorticity');
    this.solids = buffer('solids');
    this.shade = buffer('shade');
    this._emitterBuffer = backend.buffers.create({
      label: 'smoke emitters',
      size: 16 * 12 * 4,
      usage: ['storage', 'copy-dst'],
    });
    this._noBodies = backend.buffers.create({
      label: 'smoke no bodies',
      size: 16,
      usage: ['storage'],
    });
    const layout = this.layout;
    this._programs = {
      solids: compileFluid(solidsGraph(layout), backend.capabilities),
      advectVelocity: compileFluid(
        advectVelocityGraph(layout),
        backend.capabilities,
      ),
      advectScalars: compileFluid(
        advectScalarsGraph(layout),
        backend.capabilities,
      ),
      vorticity: compileFluid(vorticityGraph(layout), backend.capabilities),
      confine: compileFluid(confineGraph(layout), backend.capabilities),
      divergence: compileFluid(divergenceGraph(layout), backend.capabilities),
      jacobi: compileFluid(jacobiGraph(layout), backend.capabilities),
      project: compileFluid(projectGraph(layout), backend.capabilities),
      shade: compileFluid(shadeGraph(layout), backend.capabilities),
    };
    this._runner = new ComputeRunner(backend);
  }

  /**
   * The velocity of the last update, across the faces of the cells (vec4:
   * across the low x, y and z faces of each cell; see `faceSize`).
   */
  get velocity(): GpuBuffer {
    return this._velocity[this._current];
  }

  /** The scalars of the last update (vec4: density, temperature, 0, 0). */
  get scalars(): GpuBuffer {
    return this._scalars[this._current];
  }

  /** The pressure of the last update (vec4: pressure, divergence, 0, 0). */
  get pressure(): GpuBuffer {
    return this._pressure[this._pressureCurrent];
  }

  /** The time the smoke ran, in seconds. */
  get time(): number {
    return this._time;
  }

  /** The emitters (16 at most). */
  get emitters(): readonly SmokeEmitter[] {
    return this._emitters;
  }

  /** The bounds of the grid in the world: its lowest and highest corners. */
  get box(): { min: [number, number, number]; max: [number, number, number] } {
    const { origin, nx, ny, nz, cell } = this.layout;
    return {
      min: [origin.x, origin.y, origin.z],
      max: [origin.x + nx * cell, origin.y + ny * cell, origin.z + nz * cell],
    };
  }

  /** A sphere pouring smoke and heat, and blowing: a fire, a chimney, a fan. */
  addEmitter(emitter: SmokeEmitter): SmokeEmitter {
    if (this._emitters.length >= 16) {
      throw new Error('The smoke has 16 emitters at most');
    }
    this._emitters.push(emitter);
    return emitter;
  }

  removeEmitter(emitter: SmokeEmitter): void {
    const index = this._emitters.indexOf(emitter);
    if (index >= 0) {
      this._emitters.splice(index, 1);
    }
  }

  /** Changes an emitter: its position, its rates (the same object as given). */
  replaceEmitter(emitter: SmokeEmitter, next: SmokeEmitter): SmokeEmitter {
    const index = this._emitters.indexOf(emitter);
    if (index < 0) {
      throw new Error('Unknown emitter');
    }
    this._emitters[index] = next;
    return next;
  }

  /**
   * Runs the smoke for `dt` seconds on the GPU (one step: the advection is
   * stable for any dt): the obstacles, the advection, the vorticity, the
   * pressure, the projection; then the shade for the rendering. Submitted
   * at once.
   */
  update(dt: number, bodies?: FluidBodies): void {
    if (dt <= 0) {
      return;
    }
    this._time += dt;
    writeData(this._emitterBuffer, packEmitters(this._emitters));
    const cells = volumeWorkgroups(this.layout);
    const faces = volumeWorkgroups(this.layout, faceSize(this.layout));
    const encoder = this._backend.createCommandEncoder();
    const dispatch = (
      program: FluidProgram,
      workgroups: readonly [number, number, number],
      values: Record<string, GpuBuffer | number | readonly number[]>,
    ) => {
      // A pass per dispatch: each one reads what the last one wrote.
      const pass = encoder.beginComputePass(program.program.name);
      recordFluid(this._runner, pass, program, values, workgroups);
      pass.end();
    };
    const p = this.parameters;
    const [a, b] = [this._current, 1 - this._current];
    dispatch(this._programs.solids, cells, {
      bodies: bodies && bodies.count > 0 ? bodies.buffer : this._noBodies,
      bodyCount: bodies?.count ?? 0,
      solids: this.solids,
    });
    const emitters = {
      emitters: this._emitterBuffer,
      emitterCount: this._emitters.length,
    };
    dispatch(this._programs.advectVelocity, faces, {
      velocity: this._velocity[a],
      scalars: this._scalars[a],
      solids: this.solids,
      ...emitters,
      nextVelocity: this._velocity[b],
      dt,
      buoyancy: p.buoyancy,
      weight: p.weight,
    });
    dispatch(this._programs.advectScalars, cells, {
      velocity: this._velocity[a],
      scalars: this._scalars[a],
      solids: this.solids,
      ...emitters,
      nextScalars: this._scalars[b],
      dt,
      time: this._time,
      densityDecay: p.densityDecay,
      cooling: p.cooling,
    });
    dispatch(this._programs.vorticity, cells, {
      velocity: this._velocity[b],
      vorticity: this._vorticity,
    });
    dispatch(this._programs.confine, faces, {
      velocity: this._velocity[b],
      vorticity: this._vorticity,
      solids: this.solids,
      nextVelocity: this._velocity[a],
      dt,
      confinement: p.vorticity,
    });
    let pressure = this._pressureCurrent;
    dispatch(this._programs.divergence, cells, {
      velocity: this._velocity[a],
      pressure: this._pressure[pressure],
      nextPressure: this._pressure[1 - pressure],
    });
    pressure = 1 - pressure;
    for (let i = 0; i < p.iterations; i++) {
      dispatch(this._programs.jacobi, cells, {
        pressure: this._pressure[pressure],
        solids: this.solids,
        nextPressure: this._pressure[1 - pressure],
      });
      pressure = 1 - pressure;
    }
    this._pressureCurrent = pressure;
    dispatch(this._programs.project, faces, {
      velocity: this._velocity[a],
      pressure: this._pressure[pressure],
      solids: this.solids,
      nextVelocity: this._velocity[b],
    });
    this._current = b;
    dispatch(this._programs.shade, cells, {
      scalars: this._scalars[b],
      shade: this.shade,
      sunDirection: this.sunDirection,
      extinction: this.extinction,
      lightSteps: this.lightSteps,
    });
    this._backend.submit([encoder.finish()]);
  }

  /** Clears the smoke, the heat and the motion. */
  reset(): void {
    const zeros = new Float32Array(
      this.layout.nx * this.layout.ny * this.layout.nz * 4,
    );
    const [fx, fy, fz] = faceSize(this.layout);
    for (const buffer of this._velocity) {
      writeData(buffer, new Float32Array(fx * fy * fz * 4));
    }
    for (const buffer of [
      ...this._scalars,
      ...this._pressure,
      this._vorticity,
      this.shade,
    ]) {
      writeData(buffer, zeros);
    }
    this._time = 0;
  }

  /** An empty smoke on the CPU with this layout, for the steps of the CPU. */
  cpuState(): SmokeState {
    return createSmokeState(this.layout);
  }

  destroy(): void {
    this._runner.destroy();
    for (const buffer of [
      ...this._velocity,
      ...this._scalars,
      ...this._pressure,
      this._vorticity,
      this.solids,
      this.shade,
      this._emitterBuffer,
      this._noBodies,
    ]) {
      buffer.destroy();
    }
  }
}
