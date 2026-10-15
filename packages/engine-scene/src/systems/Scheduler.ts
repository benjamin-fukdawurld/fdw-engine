import { FixedStep } from './FixedStep';

/**
 * When a system runs in a frame:
 * - `begin`: once, first (reading the input, the events of the frame);
 * - `fixed`: at each fixed step, zero or more times (the logic, the physics);
 * - `update`: once, after the steps (the cameras, the animations, drawing
 *   between two steps);
 * - `render`: once, last (the rendering).
 */
export type Phase = 'begin' | 'fixed' | 'update' | 'render';

/** The phases, in the order they run. */
export const phases: readonly Phase[] = ['begin', 'fixed', 'update', 'render'];

/**
 * What a system does: `dt` is the step in the `fixed` phase, the time of
 * the frame in the others.
 */
export type SystemRun = (dt: number) => void;

export interface SystemOptions {
  /** Default `update`. */
  readonly phase?: Phase;
  /** Systems of the same phase this one runs before. */
  readonly before?: readonly string[];
  /** Systems of the same phase this one runs after. */
  readonly after?: readonly string[];
  /** Default true. */
  readonly enabled?: boolean;
}

/** A system of a scheduler. */
export interface System {
  readonly name: string;
  readonly phase: Phase;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly run: SystemRun;
  /** A disabled system keeps its place, and is skipped. */
  enabled: boolean;
}

export interface SchedulerOptions {
  /** The length of a fixed step, in seconds. Default 1/60. */
  readonly step?: number;
  /** The most fixed steps in a frame. Default 5. */
  readonly maxSteps?: number;
}

/**
 * Runs systems in order, frame after frame: the systems of each phase in
 * the order of their constraints (`before`, `after`), else in the order
 * they were added; the `fixed` phase at a fixed step, the others once per
 * frame.
 *
 * It knows nothing of the world: a system is a function, which reaches
 * its world, its queries, its renderer as it wants.
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler();
 * scheduler.add('input', () => input.update(), { phase: 'begin' });
 * scheduler.add('move', (step) => move(step), { phase: 'fixed' });
 * scheduler.add('gravity', (step) => fall(step), { phase: 'fixed', before: ['move'] });
 * scheduler.add('render', () => renderer.render(view), { phase: 'render' });
 * onFrame((dt) => scheduler.update(dt));
 * ```
 */
export class Scheduler {
  /** The fixed step: `step`, `maxSteps` and `alpha`. */
  readonly fixed: FixedStep;
  /** Paused, the `fixed` phase stops; the others still run. */
  paused = false;
  /**
   * The speed of the simulated time: 0.25 for a slow motion. The `fixed`
   * phase only; the other phases receive the time of the frame.
   */
  timeScale = 1;
  private readonly _systems = new Map<string, System>();
  private _ordered: Record<Phase, System[]> | undefined;
  private _time = 0;
  private _steps = 0;
  private _frame = 0;

  constructor({ step = 1 / 60, maxSteps = 5 }: SchedulerOptions = {}) {
    this.fixed = new FixedStep(step, maxSteps);
  }

  /** The simulated time: the fixed steps run, in seconds. */
  get time(): number {
    return this._time;
  }

  /** The number of fixed steps of the last frame. */
  get steps(): number {
    return this._steps;
  }

  /** The number of frames run. */
  get frame(): number {
    return this._frame;
  }

  /**
   * Where the last frame is between the last step and the next, from 0 to
   * 1: to draw a state between the previous step and the current one.
   */
  get alpha(): number {
    return this.fixed.alpha;
  }

  /**
   * Adds a system. Its name is unique; `before` and `after` may name
   * systems not added yet, or never: those constraints are ignored.
   */
  add(name: string, run: SystemRun, options: SystemOptions = {}): System {
    if (this._systems.has(name)) {
      throw new Error(`System "${name}" already exists`);
    }
    const phase = options.phase ?? 'update';
    if (!phases.includes(phase)) {
      throw new Error(`System "${name}": unknown phase "${phase}"`);
    }
    const system: System = {
      name,
      phase,
      before: options.before ?? [],
      after: options.after ?? [],
      run,
      enabled: options.enabled ?? true,
    };
    this._systems.set(name, system);
    this._ordered = undefined;
    try {
      // A cycle is refused at once.
      this.ordered();
    } catch (error) {
      this._systems.delete(name);
      this._ordered = undefined;
      throw error;
    }
    return system;
  }

  /** Removes a system; true if it was there. */
  remove(name: string): boolean {
    const system = this._systems.get(name);
    if (!system) {
      return false;
    }
    // Skipped if its phase is running.
    system.enabled = false;
    this._systems.delete(name);
    this._ordered = undefined;
    return true;
  }

  system(name: string): System | undefined {
    return this._systems.get(name);
  }

  /** The systems of a phase, in the order they run. */
  systems(phase: Phase): readonly System[] {
    return this.ordered()[phase];
  }

  /**
   * Runs a frame of `dt` seconds: `begin`, the fixed steps the time holds,
   * `update`, `render`.
   */
  update(dt: number): void {
    runAll(this.ordered().begin, dt);
    this._steps = 0;
    if (!this.paused) {
      this._steps = this.fixed.advance(dt * this.timeScale, (step) => {
        // Sorted again if a step added or removed a system.
        runAll(this.ordered().fixed, step);
        this._time += step;
      });
    }
    runAll(this.ordered().update, dt);
    runAll(this.ordered().render, dt);
    this._frame++;
  }

  /** Runs a single fixed step, paused or not: to step through a pause. */
  step(): void {
    runAll(this.ordered().fixed, this.fixed.step);
    this._time += this.fixed.step;
  }

  private ordered(): Record<Phase, System[]> {
    this._ordered ??= sort([...this._systems.values()]);
    return this._ordered;
  }
}

function runAll(systems: readonly System[], dt: number): void {
  for (const system of systems) {
    if (system.enabled) {
      system.run(dt);
    }
  }
}

// The systems of each phase in the order of their constraints, the order
// of addition between those free of each other.
function sort(systems: System[]): Record<Phase, System[]> {
  const ordered: Record<Phase, System[]> = {
    begin: [],
    fixed: [],
    update: [],
    render: [],
  };
  for (const phase of phases) {
    const own = systems.filter((system) => system.phase === phase);
    const index = new Map(own.map((system, i) => [system.name, i]));
    // The systems that must run before each one.
    const previous = own.map(() => new Set<number>());
    own.forEach((system, i) => {
      for (const name of system.after) {
        const j = index.get(name);
        if (j !== undefined) {
          previous[i].add(j);
        }
      }
      for (const name of system.before) {
        const j = index.get(name);
        if (j !== undefined) {
          previous[j].add(i);
        }
      }
    });
    const done = new Set<number>();
    while (done.size < own.length) {
      // The first system added whose previous ones all ran.
      const next = own.findIndex(
        (_, i) => !done.has(i) && [...previous[i]].every((j) => done.has(j))
      );
      if (next < 0) {
        const cycle = own
          .filter((_, i) => !done.has(i))
          .map((system) => system.name);
        throw new Error(
          `Systems of phase "${phase}" in a cycle: ${cycle.join(', ')}`
        );
      }
      done.add(next);
      ordered[phase].push(own[next]);
    }
  }
  return ordered;
}
