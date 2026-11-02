import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BufferUsageFlags,
  Commands,
  TextureUsageFlags,
  dxcArguments,
  type ContextHandle,
} from '@fdw/engine-vulkan';
import { addonPath, loadD3D12Addon, type D3D12Addon } from './addon';
import { D3D12Device } from './D3D12Device';
import { canRun } from '@fdw/engine-backend/testing';

// On the GPU, with the debug layer when the Graphics Tools of Windows are installed:
// when the addon is built (Windows only).
const built = canRun(
  'd3d12',
  existsSync(addonPath()),
  'the Direct3D 12 addon is not built (Windows only)',
);

// The failures of fdw_dx_test_fail (native/include/fdw/d3d12.h), that the
// drivers seldom give: a hook of the addon for the tests only.
const TestFailures = { close: 1, signal: 2 } as const;
const testing = () =>
  loadD3D12Addon() as D3D12Addon & {
    testFail(context: ContextHandle, failures: number): void;
  };

describe.skipIf(!built)('D3D12Device', () => {
  let device: D3D12Device;
  beforeAll(() => {
    device = new D3D12Device({ validation: true, application: 'tests' });
  });
  afterAll(() => device?.destroy());
  // Every test leaves the debug layer silent.
  afterEach(() => {
    expect(device.takeMessages()).toEqual([]);
  });

  it('opens a GPU', () => {
    expect(device.name).not.toBe('');
  });

  it('writes buffers and reads them back', async () => {
    const buffer = device.buffers.create({
      size: 16,
      usage: ['uniform', 'copy-dst'],
      label: 'round trip',
      initialData: new Uint32Array([1, 2, 3, 4]),
    });
    buffer.write(4, new Uint32Array([7, 8]).buffer);
    expect([...new Uint32Array(await buffer.read())]).toEqual([1, 7, 8, 4]);
    // A range, and a part of the source data.
    buffer.write(0, new Uint32Array([9, 10, 11]).buffer, 4, 8);
    expect([...new Uint32Array(await buffer.read(0, 8))]).toEqual([10, 11]);
    buffer.destroy();
  });

  it('applies the writes in order, and reads after them', async () => {
    const buffer = device.buffers.create({ size: 1024, usage: ['storage'] });
    const reads: Promise<ArrayBuffer>[] = [];
    for (let i = 0; i < 20; i++) {
      // Overlapping writes: the last one wins.
      buffer.write(0, new Float32Array(256).fill(i).buffer);
      reads.push(buffer.read(0, 4));
    }
    const values = (await Promise.all(reads)).map(
      (data) => new Float32Array(data)[0],
    );
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i));
    buffer.destroy();
  });

  it('keeps a destroyed buffer until the GPU is done with it', async () => {
    const buffer = device.buffers.create({ size: 64, usage: ['vertex'] });
    buffer.write(0, new Uint8Array(64).fill(5).buffer);
    const pending = buffer.read();
    buffer.destroy();
    expect(new Uint8Array(await pending)[63]).toBe(5);
    expect(() => buffer.write(0, new ArrayBuffer(4))).toThrow(/destroyed/);
    device.waitIdle();
  });

  // The bytes of a read ticket, once the GPU is idle.
  const take = (ticket: number, size: number): Uint8Array => {
    const addon = loadD3D12Addon();
    addon.waitIdle(device.context);
    expect(addon.readReady(device.context, ticket)).toBe(true);
    const target = new Uint8Array(size);
    addon.readTake(device.context, ticket, target);
    return target;
  };
  const copyBuffer = (
    source: number,
    destination: number,
    offset: number,
    size: number,
  ) => new Uint32Array([3, source, offset, 0, destination, offset, 0, size, 0]);
  const copyTexture = (
    source: number,
    destination: number,
    width: number,
    height: number,
  ) => new Uint32Array([4, source, destination, width, height]);

  it('refuses the copies outside of the resources, and runs the next ones', () => {
    const addon = loadD3D12Addon();
    const usage = BufferUsageFlags['copy-src'] | BufferUsageFlags['copy-dst'];
    const source = addon.createBuffer(device.context, 16, usage, 'source');
    const target = addon.createBuffer(device.context, 16, usage, 'target');
    addon.writeBuffer(source, 0, new Uint32Array([1, 2, 3, 4]));
    const [from, to] = [addon.bufferId(source), addon.bufferId(target)];
    expect(() =>
      addon.submit(device.context, copyBuffer(from, to, 8, 16)),
    ).toThrow(/outside of the buffers/);
    expect(() =>
      addon.submit(device.context, copyBuffer(from, to, 2, 4)),
    ).toThrow(/multiples of 4/);
    // The indirect arguments too, inside a compute pass.
    expect(() =>
      addon.submit(device.context, new Uint32Array([12, 15, from, 8, 0, 13])),
    ).toThrow(/outside of the buffer/);
    // The context is not wedged: three valid copies run.
    for (let i = 0; i < 3; i++) {
      addon.submit(device.context, copyBuffer(from, to, 4 * i, 4));
    }
    const ticket = addon.readBuffer(target, 0, 16);
    expect([...new Uint32Array(take(ticket, 16).buffer)]).toEqual([1, 2, 3, 0]);
    addon.destroyBuffer(source);
    addon.destroyBuffer(target);
  });

  it('refuses the texture copies outside of the textures', () => {
    const addon = loadD3D12Addon();
    const usage =
      TextureUsageFlags['copy-src'] |
      TextureUsageFlags['copy-dst'] |
      TextureUsageFlags.sampled;
    const create = (width: number, format = 'rgba8unorm') =>
      addon.createTexture(
        device.context,
        format,
        '2d',
        width,
        width,
        1,
        1,
        1,
        usage,
      );
    const large = create(4);
    const small = create(2);
    const other = create(4, 'rgba16float');
    const [l, s, o] = [large, small, other].map((t) => addon.textureId(t));
    expect(() => addon.submit(device.context, copyTexture(l, s, 4, 4))).toThrow(
      /outside of the textures/,
    );
    expect(() => addon.submit(device.context, copyTexture(l, o, 4, 4))).toThrow(
      /different formats/,
    );
    addon.writeTexture(large, new Uint8Array(4 * 4 * 4).fill(9));
    addon.submit(device.context, copyTexture(l, s, 2, 2));
    const ticket = addon.readTexture(small, 0, 0, 2, 2);
    expect([...take(ticket, 16)]).toEqual(new Array(16).fill(9));
    for (const texture of [large, small, other]) addon.destroyTexture(texture);
  });

  it('drops a command list that fails to close, and runs the next ones', () => {
    const addon = testing();
    const usage = BufferUsageFlags['copy-src'] | BufferUsageFlags['copy-dst'];
    const source = addon.createBuffer(device.context, 16, usage, 'source');
    const target = addon.createBuffer(device.context, 16, usage, 'target');
    addon.writeBuffer(source, 0, new Uint32Array([1, 2, 3, 4]));
    const textures = [0, 1].map(() =>
      addon.createTexture(
        device.context,
        'rgba8unorm',
        '2d',
        2,
        2,
        1,
        1,
        1,
        TextureUsageFlags['copy-src'] | TextureUsageFlags['copy-dst'],
      ),
    );
    addon.writeTexture(textures[0], new Uint8Array(16).fill(9));
    addon.waitIdle(device.context);
    const [from, to] = [addon.bufferId(source), addon.bufferId(target)];
    const [a, b] = textures.map((t) => addon.textureId(t));
    // The list fails to close (audit §4.2): its copies never run, and the
    // textures it used are back in their states before it.
    addon.testFail(device.context, TestFailures.close);
    expect(() =>
      addon.submit(
        device.context,
        new Uint32Array([
          ...copyBuffer(from, to, 0, 16),
          ...copyTexture(a, b, 2, 2),
        ]),
      ),
    ).toThrow(/Closing a command list failed/);
    // The debug layer reports the invalid copy of the failure.
    device.takeMessages();
    // The context is not wedged: three valid copies run, and the textures
    // copied without wrong states.
    for (let i = 0; i < 3; i++) {
      addon.submit(device.context, copyBuffer(from, to, 4 * i, 4));
    }
    addon.submit(device.context, copyTexture(a, b, 2, 2));
    const buffer = addon.readBuffer(target, 0, 16);
    expect([...new Uint32Array(take(buffer, 16).buffer)]).toEqual([1, 2, 3, 0]);
    const pixels = addon.readTexture(textures[1], 0, 0, 2, 2);
    expect([...take(pixels, 16)]).toEqual(new Array(16).fill(9));
    addon.destroyBuffer(source);
    addon.destroyBuffer(target);
    for (const texture of textures) addon.destroyTexture(texture);
  });

  it('is lost once a submission cannot be signalled', () => {
    const addon = testing();
    // A context of its own: it stays lost.
    const context = addon.createContext(false, 'tests', false);
    try {
      const buffer = addon.createBuffer(
        context,
        16,
        BufferUsageFlags['copy-dst'],
      );
      addon.writeBuffer(buffer, 0, new Uint32Array(4));
      addon.testFail(context, TestFailures.signal);
      expect(() => addon.submit(context, new Uint32Array())).toThrow(
        /Signal failed/,
      );
      // Nothing is recorded or recycled any more, the allocators of the
      // lists may still be in use.
      expect(() => addon.submit(context, new Uint32Array())).toThrow(
        /device is lost/,
      );
      expect(() => addon.writeBuffer(buffer, 0, new Uint32Array(4))).toThrow(
        /device is lost/,
      );
      expect(() => addon.waitIdle(context)).toThrow();
      addon.destroyBuffer(buffer);
    } finally {
      addon.destroyContext(context);
    }
  });

  it('refuses the queries out of the pool, without overflow', (test) => {
    const addon = loadD3D12Addon();
    if (!addon.timestampsSupported(device.context)) {
      test.skip();
    }
    const pool = addon.createQueryPool(device.context, 4);
    const id = addon.queryPoolId(pool);
    // first + count wraps around to 0 in 32 bits.
    for (const words of [
      [Commands.writeTimestamp, id, 0xffffffff],
      [Commands.writeTimestamp, id, 4],
      [Commands.resetQueries, id, 1, 0xffffffff],
      [Commands.resetQueries, id, 3, 2],
    ]) {
      expect(() =>
        addon.submit(device.context, new Uint32Array(words)),
      ).toThrow(/Queries out of the pool/);
    }
    expect(() =>
      addon.readQueryPool(pool, 0xffffffff, 1, new Float64Array(1)),
    ).toThrow(/Queries out of the pool/);
    // Inside: written and read.
    addon.submit(
      device.context,
      new Uint32Array([
        Commands.resetQueries,
        id,
        0,
        4,
        Commands.writeTimestamp,
        id,
        3,
      ]),
    );
    addon.waitIdle(device.context);
    const nanoseconds = new Float64Array(1);
    expect(addon.readQueryPool(pool, 3, 1, nanoseconds)).toBe(true);
    addon.destroyQueryPool(pool);
  });

  it('copies depth24plus-stencil8 by planes, 4 bytes of depth a pixel', () => {
    const addon = loadD3D12Addon();
    const usage =
      TextureUsageFlags['copy-src'] |
      TextureUsageFlags['copy-dst'] |
      TextureUsageFlags['render-attachment'];
    const create = () =>
      addon.createTexture(
        device.context,
        'depth24plus-stencil8',
        '2d',
        2,
        2,
        1,
        1,
        1,
        usage,
      );
    const source = create();
    const target = create();
    const depths = new Float32Array([0.25, 0.5, 0.75, 1]);
    addon.writeTexture(source, depths);
    addon.submit(
      device.context,
      copyTexture(addon.textureId(source), addon.textureId(target), 2, 2),
    );
    const ticket = addon.readTexture(target, 0, 0, 2, 2);
    expect([...new Float32Array(take(ticket, 16).buffer)]).toEqual([...depths]);
    addon.destroyTexture(source);
    addon.destroyTexture(target);
  });

  it('reports the misuses', () => {
    const buffer = device.buffers.create({ size: 8, usage: ['index'] });
    expect(() => buffer.write(4, new ArrayBuffer(8))).toThrow(
      /outside of the buffer \(8 bytes\)/,
    );
    buffer.destroy();
  });
});

describe.skipIf(!built)('D3D12Device on WARP', () => {
  it('opens the software rasterizer of Windows', async () => {
    const device = new D3D12Device({ application: 'tests', adapter: 'warp' });
    try {
      expect(device.name).toBe('Microsoft Basic Render Driver');
      const buffer = device.buffers.create({
        size: 8,
        usage: ['storage'],
        initialData: new Uint32Array([3, 4]),
      });
      expect([...new Uint32Array(await buffer.read())]).toEqual([3, 4]);
      buffer.destroy();
    } finally {
      device.destroy();
    }
  });
});

describe.skipIf(!built)('the compilation for a cache', () => {
  it('compiles to DXIL without a shader, and tells the version of DXC', () => {
    const addon = loadD3D12Addon();
    const hlsl = '[numthreads(1, 1, 1)] void cs_main() {}';
    expect(addon.dxcVersion()).toMatch(/^\d+\.\d+/);
    const code = addon.compileHlsl(
      hlsl,
      dxcArguments('compute', 'cs_main', 'd3d12', hlsl),
    );
    // A DXIL container.
    expect(new TextDecoder().decode(code.subarray(0, 4))).toBe('DXBC');
    // The validator that signed it is a part of the version.
    expect(addon.dxcVersion()).toMatch(/ dxil /);
  });

  it('refuses arguments that are not strings, and too many', () => {
    const addon = loadD3D12Addon();
    expect(() =>
      addon.compileHlsl('x', ['-T', 1 as unknown as string]),
    ).toThrow(TypeError);
    expect(() => addon.compileHlsl('x', 'xx' as unknown as string[])).toThrow(
      TypeError,
    );
    expect(() =>
      addon.compileHlsl('x', new Array<string>(201).fill('-O3')),
    ).toThrow(RangeError);
  });

  it('refuses a corrupt DXIL container', () => {
    const addon = loadD3D12Addon();
    const context = addon.createContext(false, 'tests', false);
    try {
      const hlsl = '[numthreads(1, 1, 1)] void cs_main() {}';
      const args = dxcArguments('compute', 'cs_main', 'd3d12', hlsl);
      const code = addon.compileHlsl(hlsl, args);
      addon.destroyShader(addon.createShaderFromCode(context, code, args));
      for (const corrupt of [
        code.subarray(0, code.length - 4),
        new Uint8Array(code.length),
        new TextEncoder().encode('DXBC'),
      ]) {
        expect(() =>
          addon.createShaderFromCode(context, corrupt, args),
        ).toThrow(/not a DXIL container/);
      }
    } finally {
      addon.destroyContext(context);
    }
  });
});
