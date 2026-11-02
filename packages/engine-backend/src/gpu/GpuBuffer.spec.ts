import { describe, expect, it } from 'vitest';
import { checkBufferWrite } from './GpuBuffer';

describe('checkBufferWrite', () => {
  const buffer = { size: 10, usage: ['vertex', 'copy-dst'] as const };

  it('returns the bytes written', () => {
    expect(checkBufferWrite(buffer, 0, new ArrayBuffer(8))).toBe(8);
    expect(checkBufferWrite(buffer, 4, new ArrayBuffer(8), 2, 4)).toBe(4);
    // The last bytes of a buffer whose size is not a multiple of 4.
    expect(checkBufferWrite(buffer, 8, new ArrayBuffer(2))).toBe(2);
    expect(checkBufferWrite(buffer, 4, new ArrayBuffer(6))).toBe(6);
  });

  it('rejects writes that would overwrite the next bytes', () => {
    expect(() => checkBufferWrite(buffer, 0, new ArrayBuffer(2))).toThrow(
      /multiple of 4, unless it ends the buffer/,
    );
  });

  it('rejects unaligned offsets and out-of-range writes', () => {
    expect(() => checkBufferWrite(buffer, 2, new ArrayBuffer(4))).toThrow(
      /multiple of 4/,
    );
    expect(() => checkBufferWrite(buffer, 8, new ArrayBuffer(4))).toThrow(
      /exceeds buffer size/,
    );
    expect(() => checkBufferWrite(buffer, 0, new ArrayBuffer(4), 2, 4)).toThrow(
      /exceeds source data size/,
    );
    expect(() => checkBufferWrite(buffer, -4, new ArrayBuffer(4))).toThrow(
      /invalid write/,
    );
  });

  it('needs copy-dst, except for the initial data', () => {
    const vertices = { size: 4, usage: ['vertex'] as const, label: 'v' };
    expect(() => checkBufferWrite(vertices, 0, new ArrayBuffer(4))).toThrow(
      /"v" was not created with 'copy-dst'/,
    );
    expect(
      checkBufferWrite(vertices, 0, new ArrayBuffer(4), 0, undefined, {
        initial: true,
      }),
    ).toBe(4);
  });
});
