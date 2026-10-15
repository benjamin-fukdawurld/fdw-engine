import { describe, expect, it } from 'vitest';
import { FixedStep } from './FixedStep';
import { Scheduler } from './Scheduler';

describe('FixedStep', () => {
  it('runs as many steps as the frames hold, at most a few', () => {
    const loop = new FixedStep(0.1, 3);
    let steps = 0;
    expect(loop.advance(0.25, () => steps++)).toBe(2);
    expect(loop.alpha).toBeCloseTo(0.5);
    // The 0.05 left, and 0.05 more: one step.
    loop.advance(0.05, () => steps++);
    expect(steps).toBe(3);
    expect(loop.alpha).toBeCloseTo(0);
    // A long pause: three steps, not ten.
    loop.advance(1, () => steps++);
    expect(steps).toBe(6);
    loop.advance(0.05, () => steps++);
    loop.reset();
    expect(loop.alpha).toBe(0);
  });
});

describe('Scheduler', () => {
  // A scheduler recording the systems run, with their dt.
  const recording = () => {
    const runs: string[] = [];
    const scheduler = new Scheduler({ step: 0.1 });
    const record = (name: string) => (dt: number) =>
      runs.push(`${name} ${Math.round(dt * 1000) / 1000}`);
    return { runs, scheduler, record };
  };

  it('runs the phases in order, the fixed one at each step', () => {
    const { runs, scheduler, record } = recording();
    // Added out of order: the phases decide.
    scheduler.add('render', record('render'), { phase: 'render' });
    scheduler.add('camera', record('camera'));
    scheduler.add('move', record('move'), { phase: 'fixed' });
    scheduler.add('input', record('input'), { phase: 'begin' });
    scheduler.update(0.25);
    expect(runs).toEqual([
      'input 0.25',
      'move 0.1',
      'move 0.1',
      'camera 0.25',
      'render 0.25',
    ]);
    expect(scheduler.steps).toBe(2);
    expect(scheduler.time).toBeCloseTo(0.2);
    expect(scheduler.alpha).toBeCloseTo(0.5);
    expect(scheduler.frame).toBe(1);
    // No step in a short frame: the other phases still run.
    runs.length = 0;
    scheduler.update(0.02);
    expect(runs).toEqual(['input 0.02', 'camera 0.02', 'render 0.02']);
    expect(scheduler.steps).toBe(0);
  });

  it('orders the systems of a phase by their constraints', () => {
    const { runs, scheduler } = recording();
    const add = (name: string, options = {}) =>
      scheduler.add(name, () => runs.push(name), {
        phase: 'fixed',
        ...options,
      });
    add('collide', { after: ['move'] });
    add('move');
    add('gravity', { before: ['move'] });
    add('score');
    // A system not added: ignored.
    add('damage', { after: ['collide', 'physics'] });
    expect(scheduler.systems('fixed').map((system) => system.name)).toEqual([
      'gravity',
      'move',
      'collide',
      'score',
      'damage',
    ]);
    scheduler.update(0.1);
    expect(runs).toEqual(['gravity', 'move', 'collide', 'score', 'damage']);
  });

  it('ignores the constraints on systems of another phase', () => {
    const { scheduler } = recording();
    scheduler.add('a', () => undefined, { after: ['b'] });
    scheduler.add('b', () => undefined, { phase: 'begin', after: ['a'] });
    expect(scheduler.systems('update').map((system) => system.name)).toEqual([
      'a',
    ]);
  });

  it('refuses a cycle, and a name taken', () => {
    const { scheduler } = recording();
    scheduler.add('a', () => undefined, { after: ['b'] });
    expect(() => scheduler.add('b', () => undefined, { after: ['a'] })).toThrow(
      'Systems of phase "update" in a cycle: a, b'
    );
    // Not added: the scheduler still runs.
    expect(scheduler.system('b')).toBeUndefined();
    scheduler.update(0.1);
    expect(() => scheduler.add('a', () => undefined)).toThrow(
      'System "a" already exists'
    );
  });

  it('skips the disabled systems, and those removed while running', () => {
    const { runs, scheduler } = recording();
    scheduler.add('first', () => {
      runs.push('first');
      scheduler.remove('second');
    });
    scheduler.add('second', () => runs.push('second'));
    const third = scheduler.add('third', () => runs.push('third'), {
      enabled: false,
    });
    scheduler.update(0.1);
    expect(runs).toEqual(['first']);
    third.enabled = true;
    scheduler.update(0.1);
    expect(runs).toEqual(['first', 'first', 'third']);
    expect(scheduler.remove('second')).toBe(false);
  });

  it('pauses, slows down and steps the fixed phase', () => {
    const { runs, scheduler, record } = recording();
    scheduler.add('move', record('move'), { phase: 'fixed' });
    scheduler.add('camera', record('camera'));
    scheduler.paused = true;
    scheduler.update(0.3);
    expect(runs).toEqual(['camera 0.3']);
    // One step through the pause.
    scheduler.step();
    expect(runs).toEqual(['camera 0.3', 'move 0.1']);
    expect(scheduler.time).toBeCloseTo(0.1);
    // A quarter of the speed: a step every 0.4 s of frames.
    runs.length = 0;
    scheduler.paused = false;
    scheduler.timeScale = 0.25;
    scheduler.update(0.2);
    scheduler.update(0.2);
    expect(runs).toEqual(['camera 0.2', 'move 0.1', 'camera 0.2']);
  });

  it('caps the steps of a long frame', () => {
    const { scheduler } = recording();
    let steps = 0;
    scheduler.add('move', () => steps++, { phase: 'fixed' });
    scheduler.update(10);
    expect(steps).toBe(5);
  });
});
