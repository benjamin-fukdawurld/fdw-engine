import { texelLayout } from '@fdw/engine-backend';
import type { GpuTextureRegion } from '@fdw/engine-backend';
import { GL } from '../gl';
import { FramebufferAttachment, framebufferFor } from './framebuffers';

// What readPixels reads for each kind of format: four channels in the
// combinations every implementation accepts (OpenGL ES 3.0, 4.3.2), then
// repacked in the layout of the format.
function readFormat(attachment: FramebufferAttachment): {
  format: GLenum;
  type: GLenum;
  read: (bytes: number) => Uint8Array | Uint32Array | Int32Array | Float32Array;
} {
  if (attachment.format === 'rgb10a2unorm') {
    return {
      format: GL.RGBA,
      type: GL.UNSIGNED_INT_2_10_10_10_REV,
      read: (bytes) => new Uint8Array(bytes),
    };
  }
  switch (texelLayout(attachment.format)?.kind) {
    case 'unorm':
      return {
        format: GL.RGBA,
        type: GL.UNSIGNED_BYTE,
        read: (pixels) => new Uint8Array(pixels * 4),
      };
    case 'float':
      return {
        format: GL.RGBA,
        type: GL.FLOAT,
        read: (pixels) => new Float32Array(pixels * 4),
      };
    case 'uint':
      return {
        format: GL.RGBA_INTEGER,
        type: GL.UNSIGNED_INT,
        read: (pixels) => new Uint32Array(pixels * 4),
      };
    case 'sint':
      return {
        format: GL.RGBA_INTEGER,
        type: GL.INT,
        read: (pixels) => new Int32Array(pixels * 4),
      };
    default:
      throw new Error(`${attachment.format} cannot be read back`);
  }
}

// The fence of the commands before, signaled without blocking the thread.
function signaled(gl: WebGL2RenderingContext): Promise<void> {
  const sync = gl.fenceSync(GL.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    // A lost context: nothing to wait for.
    return Promise.resolve();
  }
  gl.flush();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === GL.TIMEOUT_EXPIRED) {
        setTimeout(poll, 1);
        return;
      }
      gl.deleteSync(sync);
      if (status === GL.WAIT_FAILED) {
        reject(new Error('The GPU failed to read the texture back'));
      } else {
        resolve();
      }
    };
    poll();
  });
}

const float = new Float32Array(1);
const floatBits = new Uint32Array(float.buffer);

// The bits of the half float nearest to a float.
export function toHalf(value: number): number {
  float[0] = value;
  const bits = floatBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) {
    // Infinities and NaN.
    return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  }
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) {
    return sign | 0x7c00;
  }
  if (halfExponent <= 0) {
    // Subnormal, or zero.
    if (halfExponent < -10) {
      return sign;
    }
    const shifted = (mantissa | 0x800000) >>> (1 - halfExponent);
    return sign | ((shifted + 0x1000) >>> 13);
  }
  // Rounded to nearest: a carry goes into the exponent, as it should.
  return (
    (sign | (halfExponent << 10) | (mantissa >>> 13)) + ((mantissa >>> 12) & 1)
  );
}

// The four channels read, in the layout of the format.
type TypedArrayType =
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor
  | Float32ArrayConstructor;

function repack(
  attachment: FramebufferAttachment,
  read: Uint8Array | Uint32Array | Int32Array | Float32Array,
  pixels: number,
): Uint8Array {
  const layout = texelLayout(attachment.format);
  if (!layout) {
    // rgb10a2unorm, read as stored.
    return read as Uint8Array;
  }
  const { channels, bytesPerChannel, kind } = layout;
  const count = pixels * channels;
  const swap = attachment.format.startsWith('bgra');
  const arrays: Record<string, Record<number, TypedArrayType | undefined>> = {
    // Half floats as their bits.
    float: { 2: Uint16Array, 4: Float32Array },
    sint: { 1: Int8Array, 2: Int16Array, 4: Int32Array },
    uint: { 1: Uint8Array, 2: Uint16Array, 4: Uint32Array },
    unorm: { 1: Uint8Array },
  };
  const Values = arrays[kind][bytesPerChannel];
  if (!Values) {
    throw new Error(`${attachment.format} cannot be read back`);
  }
  const values = new Values(count);
  const half = kind === 'float' && bytesPerChannel === 2;
  for (let pixel = 0; pixel < pixels; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      // BGRA formats are stored as RGBA in OpenGL.
      const from =
        swap && channel !== 1 && channel !== 3 ? 2 - channel : channel;
      const value = read[pixel * 4 + from];
      values[pixel * channels + channel] = half ? toHalf(value) : value;
    }
  }
  return new Uint8Array(values.buffer);
}

/**
 * Reads a region of a color attachment (rows from the top) into a pixel
 * buffer, then returns its rows from the top, tightly packed, in the layout
 * of its format, once a fence says the GPU is done: without blocking.
 */
export async function readAttachment(
  gl: WebGL2RenderingContext,
  attachment: FramebufferAttachment,
  region: GpuTextureRegion,
): Promise<ArrayBuffer> {
  const { x, y, width, height } = region;
  const { format, type, read } = readFormat(attachment);
  const data = read(width * height);
  const buffer = gl.createBuffer();
  gl.bindFramebuffer(GL.READ_FRAMEBUFFER, framebufferFor(gl, attachment));
  gl.readBuffer(GL.COLOR_ATTACHMENT0);
  gl.bindBuffer(GL.PIXEL_PACK_BUFFER, buffer);
  gl.bufferData(GL.PIXEL_PACK_BUFFER, data.byteLength, GL.STREAM_READ);
  gl.pixelStorei(GL.PACK_ALIGNMENT, 1);
  // OpenGL images start at the bottom row.
  gl.readPixels(
    x,
    attachment.height - y - height,
    width,
    height,
    format,
    type,
    0,
  );
  gl.bindBuffer(GL.PIXEL_PACK_BUFFER, null);
  try {
    await signaled(gl);
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, buffer);
    gl.getBufferSubData(GL.PIXEL_PACK_BUFFER, 0, data);
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, null);
  } finally {
    gl.deleteBuffer(buffer);
  }
  const packed = repack(attachment, data, width * height);
  const rowBytes = packed.byteLength / height;
  const flipped = new Uint8Array(packed.byteLength);
  for (let row = 0; row < height; row++) {
    const source = (height - 1 - row) * rowBytes;
    flipped.set(packed.subarray(source, source + rowBytes), row * rowBytes);
  }
  return flipped.buffer;
}
