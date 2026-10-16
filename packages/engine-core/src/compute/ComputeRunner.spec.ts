import {
  arrayType,
  BuiltinTypes,
  compile,
  GraphBuilder,
  std,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { fakeBackend } from '../testing/fakeBackend';
import { ComputeRunner } from './ComputeRunner';

// output[i] = input[i] × factor.
function scaleProgram() {
  const g = new GraphBuilder('scale');
  const index = g.builtin('global-invocation-id').swizzle('x');
  const input = g.storage('input', arrayType(BuiltinTypes.f32));
  const output = g.storage('output', arrayType(BuiltinTypes.f32), {
    access: 'read-write',
  });
  g.write(output, {
    index,
    value: g.call(std.mul, {
      a: g.call(std.index, { array: input, index }),
      b: g.uniform('factor', BuiltinTypes.f32),
    }),
  });
  g.compute({ workgroupSize: [64, 1, 1] });
  return compile(g.build());
}

describe('ComputeRunner', () => {
  const setup = (options?: { bindGroups?: number }) => {
    const { backend, log } = fakeBackend();
    const buffer = () =>
      backend.buffers.create({ size: 256, usage: ['storage'] });
    return {
      backend,
      log,
      buffer,
      runner: new ComputeRunner(backend, options),
      program: scaleProgram(),
    };
  };

  it('reuses the bind groups of the same resources', () => {
    const { log, buffer, runner, program } = setup();
    const [input, output] = [buffer(), buffer()];
    for (let frame = 0; frame < 3; frame++) {
      runner.dispatch(program, {
        values: { input, output, factor: frame },
        workgroups: [1],
      });
    }
    expect(log.dispatches).toHaveLength(3);
    expect(log.submits).toBe(3);
    expect(runner.bindGroups).toBe(1);
    const created = log.bindGroups.length;
    runner.dispatch(program, {
      values: { input: output, output: input },
      workgroups: [1],
    });
    expect(runner.bindGroups).toBe(2);
    expect(log.bindGroups.length).toBeGreaterThan(created);
  });

  it('destroys the least recently used bind groups beyond its limit', () => {
    const { log, buffer, runner, program } = setup({ bindGroups: 2 });
    const output = buffer();
    for (let i = 0; i < 5; i++) {
      runner.dispatch(program, {
        values: { input: buffer(), output },
        workgroups: [1],
      });
    }
    expect(runner.bindGroups).toBe(2);
    expect(log.destroyedGroups).toBe(3);
    runner.destroy();
    expect(log.destroyedGroups).toBe(5);
  });

  it('records dispatches in a pass of the caller, submitted with it', () => {
    const { backend, log, buffer, runner, program } = setup();
    const encoder = backend.createCommandEncoder();
    const pass = encoder.beginComputePass('batch');
    const output = buffer();
    for (let i = 0; i < 4; i++) {
      runner.record(pass, program, {
        values: { input: buffer(), output },
        workgroups: [i + 1],
      });
    }
    pass.end();
    expect(log.submits).toBe(0);
    expect(log.computePasses).toEqual(['batch']);
    expect(log.dispatches.map((d) => d.workgroups[0])).toEqual([1, 2, 3, 4]);
  });

  it('refuses a missing resource', () => {
    const { runner, program, buffer } = setup();
    expect(() =>
      runner.dispatch(program, {
        values: { output: buffer() },
        workgroups: [1],
      }),
    ).toThrow(/no storage.* given for "input"/);
  });
});
