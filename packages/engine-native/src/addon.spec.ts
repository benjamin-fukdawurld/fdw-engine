import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAddon, WindowHandle } from './addon';
import { canRun } from '@fdw/engine-backend/testing';

// The real addon, without a window: the checks of its arguments.
const built = existsSync(new URL('../build/fdw_native.node', import.meta.url));

// A BMP of 1 × 1 pixel, 24 bits: blue 1, green 2, red 3.
function bmp(): Uint8Array {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, 4, true);
  bytes.set([1, 2, 3], 54);
  return bytes;
}

// A WAV of 4 frames, mono, 16 bits at 8 kHz.
function wav(): Uint8Array {
  const bytes = new Uint8Array(44 + 8);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    bytes.set(
      [...value].map((c) => c.charCodeAt(0)),
      offset,
    );
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 8, true);
  return bytes;
}

// Detaches the bytes, and clears where they went.
function detach(bytes: Uint8Array): void {
  const moved = structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  new Uint8Array(moved).fill(0);
  expect(bytes.byteLength).toBe(0);
}

describe.skipIf(!canRun('native', built, 'the addon is not built'))(
  'the native addon',
  () => {
    it('refuses the handles of other kinds for a window', () => {
      const addon = loadAddon();
      const clip = addon.audioClipCreate(new Float32Array(2), 1, 8000);
      const notWindow = clip as unknown as WindowHandle;
      expect(() => addon.windowId(notWindow)).toThrow(TypeError);
      expect(() => addon.windowSize(notWindow)).toThrow(TypeError);
      // Ignored, the clip kept.
      addon.destroyWindow(notWindow);
      expect(addon.audioClipInfo(clip)).toEqual([2, 1, 8000]);
      addon.audioClipRelease(clip);
      expect(() => addon.windowId({} as WindowHandle)).toThrow(TypeError);
    });

    it('decodes a copy of the bytes, detached once the call returns', async () => {
      const addon = loadAddon();
      const image = bmp();
      const decoding = addon.decodeImage(image);
      detach(image);
      const decoded = await decoding;
      expect([decoded.width, decoded.height]).toEqual([1, 1]);
      expect([...decoded.pixels]).toEqual([3, 2, 1, 255]);

      const sound = wav();
      const clip = addon.audioDecode(sound);
      detach(sound);
      const handle = await clip;
      expect(addon.audioClipInfo(handle)).toEqual([4, 1, 8000]);
      addon.audioClipRelease(handle);
    });
  },
);
