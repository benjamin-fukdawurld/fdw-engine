import { describe, expect, it, vi } from 'vitest';
import { startBackend, type BackendCandidate } from './startBackend';

// A backend that starts, or throws `error`.
function candidate(name: string, error?: string): BackendCandidate<string> {
  return {
    name,
    start: vi.fn(async () => {
      if (error) throw new Error(error);
      return `${name} engine`;
    }),
  };
}

describe('startBackend', () => {
  it('starts the preferred backend without the variable', async () => {
    const vulkan = candidate('vulkan');
    const dawn = candidate('dawn');
    expect(await startBackend(undefined, vulkan, dawn)).toEqual({
      name: 'vulkan',
      value: 'vulkan engine',
    });
    expect(await startBackend('', vulkan, dawn)).toMatchObject({
      name: 'vulkan',
    });
    expect(dawn.start).not.toHaveBeenCalled();
  });

  it('starts the backend asked for', async () => {
    const vulkan = candidate('vulkan');
    expect(await startBackend('dawn', vulkan, candidate('dawn'))).toEqual({
      name: 'dawn',
      value: 'dawn engine',
    });
    expect(vulkan.start).not.toHaveBeenCalled();
  });

  it('falls back when the backend asked for does not start', async () => {
    expect(
      await startBackend(
        'vulkan',
        candidate('vulkan', 'No device'),
        candidate('dawn'),
      ),
    ).toEqual({
      name: 'dawn',
      value: 'dawn engine',
      fallback: 'vulkan: No device',
    });
  });

  it('falls back on an unknown backend', async () => {
    const vulkan = candidate('vulkan');
    expect(await startBackend('metal', vulkan, candidate('dawn'))).toEqual({
      name: 'dawn',
      value: 'dawn engine',
      fallback: 'Unknown backend metal',
    });
    expect(vulkan.start).not.toHaveBeenCalled();
  });

  it('throws when the fallback does not start either', async () => {
    await expect(
      startBackend(
        undefined,
        candidate('vulkan', 'No device'),
        candidate('dawn', 'No adapter'),
      ),
    ).rejects.toThrow('No adapter');
  });
});
