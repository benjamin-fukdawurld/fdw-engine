import type {
  GpuObjectTable,
  ObjectTableDescriptor,
} from '@fdw/engine-backend';
import { GL } from '../gl';
import { ObjectTableWidth } from '../shader/GlslEsCodegen';

// A data texture: texels written in order, ObjectTableWidth per line, read
// by texelFetch (no filtering, no flip).
class DataTexture {
  readonly texture: WebGLTexture;

  constructor(
    private readonly _gl: WebGL2RenderingContext,
    texels: number,
    private readonly _format: {
      internal: GLenum;
      format: GLenum;
      type: GLenum;
      // Components per texel.
      components: number;
    },
  ) {
    const gl = _gl;
    const height = Math.max(1, Math.ceil(texels / ObjectTableWidth));
    this.texture = gl.createTexture();
    gl.bindTexture(GL.TEXTURE_2D, this.texture);
    gl.texStorage2D(
      GL.TEXTURE_2D,
      1,
      _format.internal,
      ObjectTableWidth,
      height,
    );
    // Integer textures are complete only without filtering.
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    gl.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 0);
  }

  // Writes `data` from the texel `first`, line after line.
  write(first: number, data: ArrayBufferView<ArrayBuffer>): void {
    const gl = this._gl;
    const { format, type, components } = this._format;
    const values = data as unknown as ArrayLike<number> & ArrayBufferView;
    const texels = values.length / components;
    gl.bindTexture(GL.TEXTURE_2D, this.texture);
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    let written = 0;
    while (written < texels) {
      const texel = first + written;
      const x = texel % ObjectTableWidth;
      const y = Math.floor(texel / ObjectTableWidth);
      const count = Math.min(ObjectTableWidth - x, texels - written);
      gl.texSubImage2D(
        GL.TEXTURE_2D,
        0,
        x,
        y,
        count,
        1,
        format,
        type,
        values,
        written * components,
      );
      written += count;
    }
  }

  destroy(): void {
    this._gl.deleteTexture(this.texture);
  }
}

/**
 * The object table of WebGL2, which has no storage buffers: two data
 * textures, the rows (RGBA32F, a row on consecutive texels) and the row of
 * each instance (R32UI), read with texelFetch (see ObjectTableNames).
 */
export class WebGl2ObjectTable implements GpuObjectTable {
  readonly rows: number;
  readonly instances: number;
  readonly rowTexture: DataTexture;
  readonly instanceTexture: DataTexture;
  private readonly _rowTexels: number;

  constructor(
    gl: WebGL2RenderingContext,
    { rows, instances, rowStride }: ObjectTableDescriptor,
  ) {
    this.rows = Math.max(rows, 1);
    this.instances = Math.max(instances, 1);
    this._rowTexels = rowStride / 16;
    this.rowTexture = new DataTexture(gl, this.rows * this._rowTexels, {
      internal: GL.RGBA32F,
      format: GL.RGBA,
      type: GL.FLOAT,
      components: 4,
    });
    this.instanceTexture = new DataTexture(gl, this.instances, {
      internal: GL.R32UI,
      format: GL.RED_INTEGER,
      type: GL.UNSIGNED_INT,
      components: 1,
    });
  }

  writeRows(firstRow: number, data: ArrayBufferView<ArrayBuffer>): void {
    this.rowTexture.write(
      firstRow * this._rowTexels,
      new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
    );
  }

  writeInstances(firstInstance: number, rows: Uint32Array<ArrayBuffer>): void {
    this.instanceTexture.write(firstInstance, rows);
  }

  destroy(): void {
    this.rowTexture.destroy();
    this.instanceTexture.destroy();
  }
}
