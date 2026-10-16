import type { GpuTexture, RenderBackend } from '@fdw/engine-backend';

/**
 * The pixels picked, in pixels of the texture from its top left corner: a
 * point (the pixel under it) or, with a width and a height, a rectangle (the
 * pixels it covers), whose width and height can be negative (dragged up or
 * left).
 */
export interface PickRegion {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

const idArrays: Record<
  string,
  typeof Uint32Array | typeof Uint16Array | typeof Uint8Array
> = {
  r32uint: Uint32Array,
  r16uint: Uint16Array,
  r8uint: Uint8Array,
};

/**
 * The identifiers of the objects in a region of a texture of identifiers
 * (an 'object-id' output of addScenePasses, in r32uint): distinct, in
 * increasing order, without 0 (no object). The part of the region out of
 * the texture is ignored. Asynchronous: the texture is read back after the
 * frames submitted before (see readTexture), a frame or two later; it needs
 * the copy-src usage.
 */
export async function pickIds(
  backend: RenderBackend,
  texture: GpuTexture,
  region: PickRegion,
): Promise<number[]> {
  const Ids = idArrays[texture.format];
  if (!Ids) {
    throw new Error(
      `pickIds reads textures of identifiers (r32uint), not ${texture.format}`,
    );
  }
  const { width: textureWidth, height: textureHeight = 1 } = texture.dimensions;
  const { x, y, width = 0, height = 0 } = region;
  // The pixels covered, at least the one under the corner, then the part
  // inside the texture.
  const covered = (start: number, size: number, limit: number) => {
    const first = Math.floor(Math.min(start, start + size));
    const end = Math.max(first + 1, Math.ceil(Math.max(start, start + size)));
    return [Math.max(0, first), Math.min(limit, end)];
  };
  const [left, right] = covered(x, width, textureWidth);
  const [top, bottom] = covered(y, height, textureHeight);
  if (left >= right || top >= bottom) {
    return [];
  }
  const data = await backend.textures.readTexture(texture, {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
  const ids = new Set(new Ids(data));
  ids.delete(0);
  return [...ids].sort((a, b) => a - b);
}
