import { beforeAll, describe, expect, it } from 'vitest';
import { glCompressedFormats } from './formats';
import { WebGl2TextureFactory } from './WebGl2Texture';

// The WebGL2 constants, outside of a browser: a number per name, those of
// the cube faces following each other.
const constants: Record<string, number> = {
  TEXTURE_2D: 1,
  TEXTURE_CUBE_MAP: 2,
  TEXTURE_2D_ARRAY: 3,
  TEXTURE_3D: 4,
  TEXTURE_CUBE_MAP_POSITIVE_X: 10,
  UNPACK_FLIP_Y_WEBGL: 20,
};
beforeAll(() => {
  let next = 100;
  Object.assign(globalThis, {
    WebGL2RenderingContext: new Proxy(constants, {
      get: (table, name: string) => (table[name] ??= next++),
    }),
  });
});

type Call = [string, ...unknown[]];

// A fake context recording the calls that write textures, with the
// extensions given.
function fakeContext(extensions: string[]) {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const gl = {
    getExtension: (name: string) => (extensions.includes(name) ? {} : null),
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    pixelStorei: record('pixelStorei'),
    texStorage2D: record('texStorage2D'),
    texStorage3D: record('texStorage3D'),
    texSubImage2D: record('texSubImage2D'),
    texSubImage3D: record('texSubImage3D'),
    compressedTexSubImage2D: record('compressedTexSubImage2D'),
    compressedTexSubImage3D: record('compressedTexSubImage3D'),
    generateMipmap: record('generateMipmap'),
  };
  const factory = new WebGl2TextureFactory(
    gl as unknown as WebGL2RenderingContext
  );
  // The calls of a name, without the data.
  const named = (name: string) =>
    calls
      .filter((call) => call[0] === name)
      .map((call) => call.slice(1).filter((arg) => !ArrayBuffer.isView(arg)));
  return { gl, factory, calls, named };
}

describe('WebGl2TextureFactory', () => {
  it('declares the compressed formats of the extensions', () => {
    const { gl } = fakeContext([
      'EXT_texture_compression_bptc',
      'WEBGL_compressed_texture_etc',
    ]);
    const formats = glCompressedFormats(
      gl as unknown as WebGL2RenderingContext
    );
    expect(formats).toContain('bc7-rgba-unorm-srgb');
    expect(formats).toContain('bc6h-rgb-ufloat');
    expect(formats).toContain('etc2-rgba8unorm');
    expect(formats).toContain('eac-r11unorm');
    expect(formats).not.toContain('bc1-rgba-unorm');
    expect(formats).not.toContain('astc-4x4-unorm');
  });

  it('writes the levels of a compressed texture by blocks', () => {
    const { factory, named, calls } = fakeContext([
      'EXT_texture_compression_bptc',
    ]);
    const texture = factory.createTexture({
      type: '2d',
      format: 'bc7-rgba-unorm',
      dimensions: { width: 8, height: 8 },
      levels: [new Uint8Array(64), new Uint8Array(16), new Uint8Array(16)],
    });
    // COMPRESSED_RGBA_BPTC_UNORM_EXT.
    expect(named('texStorage2D')).toEqual([[1, 3, 0x8e8c, 8, 8]]);
    expect(named('compressedTexSubImage2D')).toEqual([
      [1, 0, 0, 0, 8, 8, 0x8e8c],
      [1, 1, 0, 0, 4, 4, 0x8e8c],
      [1, 2, 0, 0, 2, 2, 0x8e8c],
    ]);
    // The blocks are not flipped, nothing computed.
    expect(calls).toContainEqual(['pixelStorei', 20, false]);
    expect(calls).not.toContainEqual(['pixelStorei', 20, true]);
    expect(named('generateMipmap')).toEqual([]);
    // Stored top row first: the shaders do not flip v.
    expect(texture.flipped).toBe(false);
    expect(
      factory.createTexture({
        type: '2d',
        format: 'rgba8unorm',
        dimensions: { width: 4, height: 4 },
      }).flipped
    ).toBe(true);
  });

  it('refuses the compressed formats without their extension', () => {
    const { factory } = fakeContext([]);
    expect(() =>
      factory.createTexture({
        type: '2d',
        format: 'astc-4x4-unorm',
        dimensions: { width: 4, height: 4 },
      })
    ).toThrow(/not supported \(WEBGL_compressed_texture_astc\)/);
  });

  it('writes a level, or a face of it, without computing the others', () => {
    const { factory, named } = fakeContext([]);
    const cube = factory.createTexture({
      type: 'cube',
      format: 'rgba8unorm',
      dimensions: { width: 4, height: 4, layers: 6 },
      mipLevelCount: 3,
    });
    factory.writeTexture(cube, new Uint8Array(4), { level: 2, layer: 4 });
    // The face +z (the fifth), level 2: 1×1.
    expect(named('texSubImage2D').map((call) => call.slice(0, 6))).toEqual([
      [14, 2, 0, 0, 1, 1],
    ]);
    factory.writeTexture(cube, new Uint8Array(6 * 16), { level: 1 });
    expect(
      named('texSubImage2D')
        .slice(1)
        .map((call) => call.slice(0, 2))
    ).toEqual([10, 11, 12, 13, 14, 15].map((face) => [face, 1]));
    expect(named('generateMipmap')).toEqual([]);

    // Without options: the first level, the others computed.
    factory.writeTexture(cube, new Uint8Array(6 * 64));
    expect(named('texSubImage2D')).toHaveLength(13);
    expect(named('generateMipmap')).toHaveLength(1);
  });

  it('writes a layer of an array', () => {
    const { factory, named } = fakeContext(['WEBGL_compressed_texture_etc']);
    const array = factory.createTexture({
      type: '2d-array',
      format: 'etc2-rgb8unorm',
      dimensions: { width: 4, height: 4, layers: 3 },
    });
    factory.writeTexture(array, new Uint8Array(8), { layer: 2 });
    // COMPRESSED_RGB8_ETC2, at the depth of the layer.
    expect(named('compressedTexSubImage3D')).toEqual([
      [3, 0, 0, 0, 2, 4, 4, 1, 0x9274],
    ]);
    expect(() =>
      factory.writeTexture(array, new Uint8Array(16), { layer: 2 })
    ).toThrow(/takes 8 bytes, not 16/);
  });
});
