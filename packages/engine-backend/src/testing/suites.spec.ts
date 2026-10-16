import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canRun } from './suites';

// The variable of the environment, set again after the test.
const saved = process.env['FDW_REQUIRE_SUITES'];
beforeEach(() => {
  delete process.env['FDW_REQUIRE_SUITES'];
});
afterEach(() => {
  if (saved === undefined) {
    delete process.env['FDW_REQUIRE_SUITES'];
  } else {
    process.env['FDW_REQUIRE_SUITES'] = saved;
  }
});

describe('canRun', () => {
  it('skips a suite that cannot run, unless it is required', () => {
    expect(canRun('vulkan', true)).toBe(true);
    expect(canRun('vulkan', false)).toBe(false);
    process.env['FDW_REQUIRE_SUITES'] = 'dawn, vulkan';
    expect(() => canRun('vulkan', false, 'no addon')).toThrow(
      /vulkan.*no addon/,
    );
    expect(canRun('window', false)).toBe(false);
    process.env['FDW_REQUIRE_SUITES'] = 'all';
    expect(() => canRun('window', false)).toThrow(/window/);
  });
});
