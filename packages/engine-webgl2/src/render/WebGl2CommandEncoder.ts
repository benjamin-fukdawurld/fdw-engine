import type {
  GpuAttachmentTarget,
  GpuBindGroup,
  GpuBuffer,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuComputePassEncoder,
  GpuRenderPassEncoder,
  GpuRenderPipeline,
  IndexFormat,
  RenderPassDescriptor,
  VertexAttributeFormat,
} from '@fdw/engine-backend';
import { GL } from '../gl';
import { WebGl2Buffer } from '../gpu/WebGl2Buffer';
import { WebGl2Sampler, WebGl2Texture } from '../gpu/WebGl2Texture';
import { WebGl2BindGroup, WebGl2RenderPipeline } from './WebGl2PipelineFactory';
import { WebGl2ObjectTable } from './WebGl2ObjectTable';
import { WebGl2PassTimer } from './WebGl2PassTimer';
import { WebGl2RenderTarget } from './WebGl2RenderTarget';
import { FramebufferAttachment, framebufferFor } from '../gpu/framebuffers';

type Command = (gl: WebGL2RenderingContext) => void;

// Clears a color attachment of the bound framebuffer, with the function of
// its format: integer formats take integer values.
function clearColorBuffer(
  gl: WebGL2RenderingContext,
  index: number,
  format: string,
  value: number[]
): void {
  if (format.endsWith('uint')) {
    gl.clearBufferuiv(GL.COLOR, index, value);
  } else if (format.endsWith('sint')) {
    gl.clearBufferiv(GL.COLOR, index, value);
  } else {
    gl.clearBufferfv(GL.COLOR, index, value);
  }
}

// A render target or a texture, as an attachment of a framebuffer.
function attachment(target: unknown, what: string): FramebufferAttachment {
  if (target instanceof WebGl2RenderTarget || target instanceof WebGl2Texture) {
    return target;
  }
  throw new Error(`${what} was not created by the WebGL2 backend`);
}

function unwrap<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
  what: string
): T {
  if (!(value instanceof type)) {
    throw new Error(`${what} was not created by the WebGL2 backend`);
  }
  return value;
}

// How a vertex attribute is read: 'unorm8x4' → 4 normalized unsigned bytes.
function vertexFormat(format: VertexAttributeFormat): {
  size: number;
  type: GLenum;
  normalized: boolean;
  integer: boolean;
} {
  const match = /^(float|unorm|snorm|uint|sint)(8|16|32)(?:x(\d))?$/.exec(
    format
  );
  if (!match) {
    throw new Error(`Vertex format ${format} is not supported by WebGL2`);
  }
  const [, kind, bits, count] = match;
  const signed = kind === 'snorm' || kind === 'sint';
  const types: Record<string, GLenum> = {
    float16: GL.HALF_FLOAT,
    float32: GL.FLOAT,
    '8': signed ? GL.BYTE : GL.UNSIGNED_BYTE,
    '16': signed ? GL.SHORT : GL.UNSIGNED_SHORT,
    '32': signed ? GL.INT : GL.UNSIGNED_INT,
  };
  return {
    size: count ? Number(count) : 1,
    type: kind === 'float' ? types[`float${bits}`] : types[bits],
    normalized: kind === 'unorm' || kind === 'snorm',
    integer: kind === 'uint' || kind === 'sint',
  };
}

interface DrawState {
  readonly pipeline: WebGl2RenderPipeline;
  readonly groups: readonly (WebGl2BindGroup | undefined)[];
  readonly vertexBuffers: readonly (WebGl2Buffer | undefined)[];
  readonly indexBuffer?: { buffer: WebGl2Buffer; type: GLenum };
}

function applyPipeline(
  gl: WebGL2RenderingContext,
  pipeline: WebGl2RenderPipeline
): void {
  gl.useProgram(pipeline.program.program);
  if (pipeline.cullFace === undefined) {
    gl.disable(GL.CULL_FACE);
  } else {
    gl.enable(GL.CULL_FACE);
    gl.cullFace(pipeline.cullFace);
  }
  gl.frontFace(pipeline.frontFace);
  if (pipeline.depth) {
    gl.enable(GL.DEPTH_TEST);
    gl.depthFunc(pipeline.depth.compare);
    gl.depthMask(pipeline.depth.write);
  } else {
    gl.disable(GL.DEPTH_TEST);
  }
  if (pipeline.depth?.bias) {
    gl.enable(GL.POLYGON_OFFSET_FILL);
    gl.polygonOffset(pipeline.depth.bias.slope, pipeline.depth.bias.constant);
  } else {
    gl.disable(GL.POLYGON_OFFSET_FILL);
  }
  if (pipeline.blend) {
    const { color, alpha } = pipeline.blend;
    gl.enable(GL.BLEND);
    gl.blendFuncSeparate(color[0], color[1], alpha[0], alpha[1]);
    gl.blendEquationSeparate(color[2], alpha[2]);
  } else {
    gl.disable(GL.BLEND);
  }
}

function bindVertices(gl: WebGL2RenderingContext, state: DrawState): void {
  const { pipeline } = state;
  gl.bindVertexArray(pipeline.vertexArray);
  pipeline.buffers.forEach((layout, slot) => {
    const buffer = state.vertexBuffers[slot];
    if (!buffer) {
      throw new Error(`No vertex buffer set in slot ${slot}`);
    }
    gl.bindBuffer(GL.ARRAY_BUFFER, buffer.buffer);
    for (const attribute of layout.attributes) {
      const { size, type, normalized, integer } = vertexFormat(
        attribute.format
      );
      gl.enableVertexAttribArray(attribute.location);
      if (integer) {
        gl.vertexAttribIPointer(
          attribute.location,
          size,
          type,
          layout.stride,
          attribute.offset
        );
      } else {
        gl.vertexAttribPointer(
          attribute.location,
          size,
          type,
          normalized,
          layout.stride,
          attribute.offset
        );
      }
      gl.vertexAttribDivisor(
        attribute.location,
        layout.stepMode === 'instance' ? 1 : 0
      );
    }
  });
  gl.bindBuffer(
    GL.ELEMENT_ARRAY_BUFFER,
    state.indexBuffer?.buffer.buffer ?? null
  );
}

// The sampler object of the textures read by texelFetch (textureLoad): it
// does not filter, but makes the texture complete whatever its format
// (r32float cannot be filtered linearly) and reads the depth of depth
// textures (no comparison).
const loadSamplers = new WeakMap<WebGL2RenderingContext, WebGLSampler>();
function loadSampler(gl: WebGL2RenderingContext): WebGLSampler {
  let sampler = loadSamplers.get(gl);
  if (!sampler) {
    sampler = gl.createSampler();
    gl.samplerParameteri(sampler, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    gl.samplerParameteri(sampler, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
    gl.samplerParameteri(sampler, GL.TEXTURE_COMPARE_MODE, GL.NONE);
    loadSamplers.set(gl, sampler);
  }
  return sampler;
}

function bindResources(gl: WebGL2RenderingContext, state: DrawState): void {
  const { program } = state.pipeline;
  const resource = (group: number, binding: number) => {
    const value = state.groups[group]?.resources.get(binding);
    if (!value) {
      throw new Error(
        `No resource bound at group ${group}, binding ${binding}`
      );
    }
    return value;
  };
  for (const block of program.uniformBlocks) {
    const buffer = unwrap(
      resource(block.group, block.binding),
      WebGl2Buffer,
      'The uniform buffer'
    );
    gl.bindBufferBase(GL.UNIFORM_BUFFER, block.point, buffer.buffer);
  }
  for (const { unit, texture, sampler } of program.samplers) {
    const glTexture = unwrap(
      resource(texture.group, texture.binding),
      WebGl2Texture,
      'The texture'
    );
    const glSampler = sampler
      ? unwrap(
          resource(sampler.group, sampler.binding),
          WebGl2Sampler,
          'The sampler'
        ).sampler
      : loadSampler(gl);
    gl.activeTexture(GL.TEXTURE0 + unit);
    gl.bindTexture(glTexture.target, glTexture.texture);
    gl.bindSampler(unit, glSampler);
  }
  const table = program.objectTable;
  if (table) {
    const { group, binding } = table.binding;
    const objects = unwrap(
      resource(group, binding),
      WebGl2ObjectTable,
      'The object table'
    );
    // Read by texelFetch: no sampler object.
    for (const [unit, texture] of [
      [table.rowsUnit, objects.rowTexture.texture],
      [table.instancesUnit, objects.instanceTexture.texture],
    ] as const) {
      gl.activeTexture(GL.TEXTURE0 + unit);
      gl.bindTexture(GL.TEXTURE_2D, texture);
      gl.bindSampler(unit, null);
    }
  }
}

// The first instance of a draw, for the programs reading the object table
// (WebGL2 has no base instance). The program is in use.
function setFirstInstance(
  gl: WebGL2RenderingContext,
  state: DrawState,
  firstInstance: number
): void {
  const location = state.pipeline.program.objectTable?.firstInstance;
  if (location) {
    gl.uniform1ui(location, firstInstance);
  }
}

// Records the commands of a pass. Each draw captures the state set before
// it; everything runs on submit.
class WebGl2RenderPassEncoder implements GpuRenderPassEncoder {
  private _pipeline?: WebGl2RenderPipeline;
  private readonly _groups: (WebGl2BindGroup | undefined)[] = [];
  private readonly _vertexBuffers: (WebGl2Buffer | undefined)[] = [];
  private _indexBuffer?: { buffer: WebGl2Buffer; type: GLenum };

  constructor(
    private readonly _commands: Command[],
    // Height of the attachments, to flip the viewports.
    private readonly _height: number,
    // Multisampled color attachments (their index in `from`), resolved at
    // the end of the pass.
    private readonly _resolve?: {
      readonly from: readonly FramebufferAttachment[];
      readonly depth?: FramebufferAttachment;
      readonly to: readonly {
        readonly index: number;
        readonly to: FramebufferAttachment;
      }[];
    },
    // Recorded after the pass: the end of its timer query.
    private readonly _onEnd?: Command
  ) {}

  setPipeline(pipeline: GpuRenderPipeline): void {
    this._pipeline = unwrap(pipeline, WebGl2RenderPipeline, 'The pipeline');
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    // OpenGL counts rows from the bottom.
    const bottom = this._height - y - height;
    this._commands.push((gl) => gl.viewport(x, bottom, width, height));
  }

  setBindGroup(index: number, group: GpuBindGroup): void {
    this._groups[index] = unwrap(group, WebGl2BindGroup, 'The bind group');
  }

  setVertexBuffer(slot: number, buffer: GpuBuffer): void {
    this._vertexBuffers[slot] = unwrap(
      buffer,
      WebGl2Buffer,
      'The vertex buffer'
    );
  }

  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat): void {
    this._indexBuffer = {
      buffer: unwrap(buffer, WebGl2Buffer, 'The index buffer'),
      type: format === 'uint16' ? GL.UNSIGNED_SHORT : GL.UNSIGNED_INT,
    };
  }

  draw(vertexCount: number, instanceCount = 1, firstInstance = 0): void {
    const state = this.state();
    this._commands.push((gl) => {
      this.prepare(gl, state);
      setFirstInstance(gl, state, firstInstance);
      gl.drawArraysInstanced(
        state.pipeline.topology,
        0,
        vertexCount,
        instanceCount
      );
    });
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstInstance = 0): void {
    const state = this.state();
    const index = state.indexBuffer;
    if (!index) {
      throw new Error('drawIndexed needs an index buffer');
    }
    this._commands.push((gl) => {
      this.prepare(gl, state);
      setFirstInstance(gl, state, firstInstance);
      gl.drawElementsInstanced(
        state.pipeline.topology,
        indexCount,
        index.type,
        0,
        instanceCount
      );
    });
  }

  end(): void {
    const resolve = this._resolve;
    this._commands.push((gl) => {
      gl.bindVertexArray(null);
      if (resolve) {
        // The samples of each attachment averaged into its resolve target,
        // read through the framebuffer of the pass.
        const from = framebufferFor(gl, resolve.from, resolve.depth);
        gl.colorMask(true, true, true, true);
        for (const { index, to } of resolve.to) {
          // Created before binding: creating a framebuffer binds it.
          const destination = framebufferFor(gl, to);
          gl.bindFramebuffer(GL.READ_FRAMEBUFFER, from);
          gl.readBuffer(GL.COLOR_ATTACHMENT0 + index);
          gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, destination);
          gl.blitFramebuffer(
            0,
            0,
            to.width,
            to.height,
            0,
            0,
            to.width,
            to.height,
            GL.COLOR_BUFFER_BIT,
            GL.NEAREST
          );
        }
        gl.bindFramebuffer(GL.READ_FRAMEBUFFER, from);
        gl.readBuffer(GL.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(GL.FRAMEBUFFER, null);
      }
    });
    if (this._onEnd) {
      this._commands.push(this._onEnd);
    }
  }

  private state(): DrawState {
    if (!this._pipeline) {
      throw new Error('No pipeline set before drawing');
    }
    return {
      pipeline: this._pipeline,
      groups: [...this._groups],
      vertexBuffers: [...this._vertexBuffers],
      indexBuffer: this._indexBuffer,
    };
  }

  private prepare(gl: WebGL2RenderingContext, state: DrawState): void {
    applyPipeline(gl, state.pipeline);
    bindVertices(gl, state);
    bindResources(gl, state);
  }
}

export class WebGl2CommandBuffer {
  constructor(readonly commands: readonly Command[]) {}

  execute(gl: WebGL2RenderingContext): void {
    for (const command of this.commands) {
      command(gl);
    }
  }
}

// WebGL draws immediately: the encoder records the commands, and the backend
// runs them on submit. As in WebGPU, the buffer writes made while recording
// are visible to every draw of the submitted commands.
export class WebGl2CommandEncoder implements GpuCommandEncoder {
  private readonly _commands: Command[] = [];

  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder {
    // No color attachment: a depth-only pass.
    const colors = descriptor.colorAttachments.map((color) => ({
      ...color,
      attachment: attachment(color.target, 'The color target'),
    }));
    const targets = colors.map((color) => color.attachment);
    const depth = descriptor.depthAttachment;
    const depthTarget = depth
      ? attachment(depth.target, 'The depth target')
      : undefined;
    const size = targets[0] ?? depthTarget;
    if (!size) {
      throw new Error('A render pass needs a color or a depth attachment');
    }

    // A measured pass: a timer query around its commands.
    const timer = descriptor.timing
      ? unwrap(descriptor.timing.timer, WebGl2PassTimer, 'The pass timer')
      : undefined;
    const query = descriptor.timing
      ? timer?.query(descriptor.timing.index)
      : undefined;
    if (timer && query) {
      this._commands.push((gl) => gl.beginQuery(timer.target, query));
    }

    this._commands.push((gl) => {
      gl.bindFramebuffer(
        GL.FRAMEBUFFER,
        framebufferFor(gl, targets, depthTarget)
      );
      gl.viewport(0, 0, size.width, size.height);
      gl.disable(GL.SCISSOR_TEST);
      // Each color attachment cleared with the function of its format.
      colors.forEach((color, i) => {
        if (color.load === 'clear') {
          const { r, g, b, a } = color.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
          gl.colorMask(true, true, true, true);
          clearColorBuffer(gl, i, color.attachment.format, [r, g, b, a]);
        }
      });
      if (depth?.load === 'clear') {
        // The depth mask also applies to clears.
        gl.depthMask(true);
        gl.clearDepth(depth.clearValue ?? 1);
        let mask = GL.DEPTH_BUFFER_BIT;
        if (depth.target.format.includes('stencil')) {
          gl.clearStencil(0);
          mask |= GL.STENCIL_BUFFER_BIT;
        }
        gl.clear(mask);
      }
    });
    // The multisampled attachments resolved at the end of the pass.
    const resolves = colors.flatMap((color, index) =>
      color.resolveTarget
        ? [
            {
              index,
              to: attachment(color.resolveTarget, 'The resolve target'),
            },
          ]
        : []
    );
    return new WebGl2RenderPassEncoder(
      this._commands,
      size.height,
      resolves.length > 0
        ? { from: targets, depth: depthTarget, to: resolves }
        : undefined,
      timer && query ? (gl) => gl.endQuery(timer.target) : undefined
    );
  }

  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number
  ): void {
    const from = unwrap(source, WebGl2Buffer, 'The source buffer');
    const to = unwrap(destination, WebGl2Buffer, 'The destination buffer');
    this._commands.push((gl) => {
      gl.bindBuffer(GL.COPY_READ_BUFFER, from.buffer);
      gl.bindBuffer(GL.COPY_WRITE_BUFFER, to.buffer);
      gl.copyBufferSubData(
        GL.COPY_READ_BUFFER,
        GL.COPY_WRITE_BUFFER,
        sourceOffset,
        destinationOffset,
        size
      );
    });
  }

  copyTextureToTexture(
    source: GpuAttachmentTarget,
    destination: GpuAttachmentTarget,
    size: { readonly width: number; readonly height: number }
  ): void {
    const from = attachment(source, 'The source texture');
    // A texture, or the texture of a color render target.
    const to =
      destination instanceof WebGl2RenderTarget
        ? {
            target: GL.TEXTURE_2D,
            texture: destination.texture,
            height: destination.height,
          }
        : unwrap(destination, WebGl2Texture, 'The destination texture');
    this._commands.push((gl) => {
      if (!to.texture) {
        throw new Error('The destination of a copy must be a color texture');
      }
      // Read through a framebuffer of the source, written to the texture.
      gl.bindFramebuffer(GL.READ_FRAMEBUFFER, framebufferFor(gl, from));
      gl.bindTexture(to.target, to.texture);
      // The top rows of the images: the last ones in storage, as OpenGL
      // stores images bottom row first.
      gl.copyTexSubImage2D(
        to.target,
        0,
        0,
        to.height - size.height,
        0,
        from.height - size.height,
        size.width,
        size.height
      );
      gl.bindFramebuffer(GL.READ_FRAMEBUFFER, null);
    });
  }

  generateMipmaps(texture: GpuAttachmentTarget): void {
    // Render targets have a single level.
    if (texture instanceof WebGl2RenderTarget) {
      return;
    }
    const levels = unwrap(texture, WebGl2Texture, 'The texture');
    this._commands.push((gl) => levels.generateMipmaps(gl));
  }

  beginComputePass(): GpuComputePassEncoder {
    throw new Error('WebGL2 has no compute shaders');
  }

  finish(): GpuCommandBuffer {
    return new WebGl2CommandBuffer([...this._commands]);
  }
}
