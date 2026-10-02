import { beforeAll, describe, expect, it } from 'vitest';
import { BufferFactory } from './BufferFactory';

// GPUBufferUsage only exists in a WebGPU context.
beforeAll(() => {
  Object.assign(globalThis, {
    GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 },
  });
});

// A fake device that applies the WebGPU validation rules relevant here and
// records the resulting bytes.
function fakeDevice() {
  const state = { bytes: new Uint8Array(0), errors: [] as string[] };
  const device = {
    createBuffer: ({ size, usage, label }: GPUBufferDescriptor) => {
      if (size % 4 !== 0) {
        state.errors.push('mappedAtCreation size must be a multiple of 4');
      }
      state.bytes = new Uint8Array(size);
      return {
        size,
        usage,
        label: label ?? '',
        getMappedRange: () => state.bytes.buffer,
        unmap: () => undefined,
        destroy: () => undefined,
      };
    },
    queue: {
      writeBuffer: (_: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
        const source =
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const length = size ?? source.byteLength - dataOffset;
        if (length % 4 !== 0 || offset % 4 !== 0) {
          state.errors.push('writeBuffer size and offset must be multiples of 4');
          return;
        }
        if (offset + length > state.bytes.byteLength) {
          state.errors.push('writeBuffer overflow');
          return;
        }
        state.bytes.set(source.subarray(dataOffset, dataOffset + length), offset);
      },
    },
  };
  return { device: device as unknown as GPUDevice, state };
}

describe('BufferFactory', () => {
  it.each([
    ['writeBuffer', ['index', 'copy-dst'] as const],
    ['mappedAtCreation', ['index'] as const],
  ])('pads an odd-sized index buffer (%s path)', (_, usage) => {
    const { device, state } = fakeDevice();
    const buffer = new BufferFactory(device).create({
      size: 6,
      usage,
      initialData: new Uint16Array([1, 300, 2]),
    });
    expect(state.errors).toEqual([]);
    expect([...state.bytes]).toEqual([1, 0, 44, 1, 2, 0, 0, 0]);
    expect(buffer.size).toBe(6);
    expect(buffer.allocatedSize).toBe(8);
  });

  it('honours the offset of a typed array view', () => {
    const { device, state } = fakeDevice();
    const view = new Float32Array([0, 0, 0, 0, 1, 2, 3, 4]).subarray(4, 8);
    new BufferFactory(device).create({ size: 16, usage: ['uniform', 'copy-dst'], initialData: view });
    expect(state.errors).toEqual([]);
    expect([...new Float32Array(state.bytes.buffer)]).toEqual([1, 2, 3, 4]);
  });

  it('rejects initial data that does not match the buffer size', () => {
    const { device } = fakeDevice();
    expect(() =>
      new BufferFactory(device).create({ size: 4, usage: ['uniform', 'copy-dst'], initialData: new Float32Array(2) })
    ).toThrow(/does not match the buffer size/);
  });

  describe('Buffer.write', () => {
    const create = () => {
      const { device, state } = fakeDevice();
      return { buffer: new BufferFactory(device).create({ size: 16, usage: ['uniform', 'copy-dst'] }), state };
    };

    it('pads writes whose size is not a multiple of 4', () => {
      const { buffer, state } = create();
      buffer.write(4, new Uint8Array([7, 8, 9]).buffer);
      expect(state.errors).toEqual([]);
      expect([...state.bytes.subarray(4, 8)]).toEqual([7, 8, 9, 0]);
    });

    it('rejects unaligned offsets and out-of-range writes', () => {
      const { buffer } = create();
      expect(() => buffer.write(2, new ArrayBuffer(4))).toThrow(/multiple of 4/);
      expect(() => buffer.write(12, new ArrayBuffer(8))).toThrow(/exceeds buffer size/);
      expect(() => buffer.write(0, new ArrayBuffer(4), 2, 4)).toThrow(/exceeds source data size/);
    });

    it('rejects buffers created without copy-dst', () => {
      const { device } = fakeDevice();
      const buffer = new BufferFactory(device).create({ size: 4, usage: ['uniform'] });
      expect(() => buffer.write(0, new ArrayBuffer(4))).toThrow(/copy-dst/);
    });
  });
});
