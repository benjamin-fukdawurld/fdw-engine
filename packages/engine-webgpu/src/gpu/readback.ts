import type { GpuTextureRegion } from '@fdw/engine-backend';

/**
 * Copies a region of the first level of a texture into a buffer mapped for
 * reading, then returns its rows tightly packed: in the order of the queue,
 * without waiting for the GPU.
 */
export async function readTextureRegion(
  device: GPUDevice,
  texture: GPUTexture,
  region: GpuTextureRegion,
  bytesPerPixel: number
): Promise<ArrayBuffer> {
  const { x, y, width, height } = region;
  const rowBytes = width * bytesPerPixel;
  // Copies need rows aligned to 256 bytes.
  const paddedRowBytes = Math.ceil(rowBytes / 256) * 256;
  const buffer = device.createBuffer({
    label: 'texture readback',
    size: paddedRowBytes * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y } },
    { buffer, bytesPerRow: paddedRowBytes },
    [width, height]
  );
  device.queue.submit([encoder.finish()]);

  try {
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(rowBytes * height);
    for (let row = 0; row < height; row++) {
      const start = row * paddedRowBytes;
      pixels.set(padded.subarray(start, start + rowBytes), row * rowBytes);
    }
    buffer.unmap();
    return pixels.buffer;
  } finally {
    buffer.destroy();
  }
}
