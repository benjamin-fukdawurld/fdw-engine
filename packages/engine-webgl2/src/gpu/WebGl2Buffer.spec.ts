import { beforeAll, describe, expect, it } from 'vitest';
import { fakeGl, installGl } from '../testing/fakeGl';
import { WebGl2BufferFactory } from './WebGl2Buffer';

beforeAll(installGl);

function setup() {
  const fake = fakeGl();
  return { ...fake, factory: new WebGl2BufferFactory(fake.gl) };
}

describe('WebGl2Buffer', () => {
  it('writes the initial data, without copy-dst', async () => {
    const { factory, bytes, C, named } = setup();
    const buffer = factory.create({
      size: 6,
      usage: ['vertex', 'copy-src'],
      initialData: new Uint16Array([1, 300, 2]),
    });
    expect(buffer.target).toBe(C.ARRAY_BUFFER);
    expect(named('bufferData')[0]).toEqual([C.ARRAY_BUFFER, 6, C.STATIC_DRAW]);
    expect([...bytes(buffer.buffer)!]).toEqual([1, 0, 44, 1, 2, 0]);
    expect([...new Uint8Array(await buffer.read(2, 2))]).toEqual([44, 1]);
    // Later writes need it, as in WebGPU.
    expect(() => buffer.write(0, new ArrayBuffer(4))).toThrow(/copy-dst/);
  });

  it('honours the offsets of the source', () => {
    const { factory, bytes } = setup();
    const buffer = factory.create({
      size: 8,
      usage: ['uniform', 'copy-dst'],
      initialData: new Uint8Array([
        0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8,
      ]).subarray(4),
    });
    buffer.write(4, new Uint8Array([0, 0, 9, 9, 9, 9]).buffer, 2, 4);
    expect([...bytes(buffer.buffer)!]).toEqual([1, 2, 3, 4, 9, 9, 9, 9]);
  });

  it('checks the writes as WebGPU does', () => {
    const { factory, bytes } = setup();
    const buffer = factory.create({ size: 10, usage: ['vertex', 'copy-dst'] });
    expect(() => buffer.write(2, new ArrayBuffer(4))).toThrow(/multiple of 4/);
    expect(() => buffer.write(8, new ArrayBuffer(4))).toThrow(
      /exceeds buffer size/,
    );
    expect(() => buffer.write(0, new ArrayBuffer(2))).toThrow(
      /unless it ends the buffer/,
    );
    // The last bytes of the buffer.
    buffer.write(8, new Uint8Array([5, 6]).buffer);
    expect([...bytes(buffer.buffer)!.subarray(8)]).toEqual([5, 6]);
  });

  it('keeps the target of the main usage', () => {
    const { factory, C, calls } = setup();
    expect(factory.create({ size: 4, usage: ['index'] }).target).toBe(
      C.ELEMENT_ARRAY_BUFFER,
    );
    // Not to change the index buffer of the bound vertex array.
    expect(calls.findIndex((call) => call[0] === 'bindVertexArray')).toBe(
      calls.findIndex((call) => call[0] === 'bindBuffer') - 1,
    );
    expect(
      factory.create({ size: 4, usage: ['uniform', 'vertex'] }).target,
    ).toBe(C.UNIFORM_BUFFER);
    expect(() => factory.create({ size: 4, usage: ['indirect'] })).toThrow(
      /no indirect commands/,
    );
    expect(() =>
      factory.create({ size: 4, usage: ['index', 'storage'] }),
    ).toThrow(/storage buffer as an index buffer/);
    expect(() => factory.create({ size: 0, usage: ['vertex'] })).toThrow(
      /greater than 0/,
    );
  });

  it('keeps the texture of a storage buffer up to date', () => {
    const { factory, named, alive } = setup();
    const buffer = factory.create({
      size: 20,
      usage: ['storage', 'copy-dst'],
    });
    // Two texels of 16 bytes: the buffer holds whole texels.
    expect(buffer.storage?.texels).toBe(2);
    expect(named('bufferData')[0][1]).toBe(32);
    expect(buffer.storage?.rows).toEqual([
      { y: 0, width: 2, height: 1, offset: 0 },
    ]);

    // Written: copied to the texture before a program reads it, once.
    buffer.write(0, new ArrayBuffer(4));
    buffer.updateTexture();
    buffer.updateTexture();
    expect(named('texSubImage2D')).toHaveLength(1);
    // Rendered to: read back into the buffer before a write, once.
    buffer.changed('texture');
    buffer.write(0, new ArrayBuffer(4));
    buffer.updateBuffer();
    expect(named('readPixels')).toHaveLength(1);

    buffer.destroy();
    buffer.destroy();
    expect(alive('buffer')).toEqual([]);
    expect(alive('texture')).toEqual([]);
    expect(() => buffer.buffer).toThrow(/was destroyed/);
  });

  it('refuses the storage buffers WebGL2 cannot hold', () => {
    const { factory } = setup();
    // 4096 rows of 2048 texels of 16 bytes at most.
    expect(() =>
      factory.create({ size: 4096 * 2048 * 16 + 16, usage: ['storage'] }),
    ).toThrow(/more than WebGL2 can hold/);
  });
});
