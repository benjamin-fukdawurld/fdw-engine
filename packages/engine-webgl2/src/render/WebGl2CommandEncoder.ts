import type {
  GpuBindGroup,
  GpuBuffer,
  GpuCommandBuffer,
  GpuCommandEncoder,
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
import { WebGl2RenderTarget } from './WebGl2RenderTarget';

type Command = (gl: WebGL2RenderingContext) => void;

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
    const glSampler = unwrap(
      resource(sampler.group, sampler.binding),
      WebGl2Sampler,
      'The sampler'
    );
    gl.activeTexture(GL.TEXTURE0 + unit);
    gl.bindTexture(glTexture.target, glTexture.texture);
    gl.bindSampler(unit, glSampler.sampler);
  }
}

// Records the commands of a pass. Each draw captures the state set before
// it; everything runs on submit.
class WebGl2RenderPassEncoder implements GpuRenderPassEncoder {
  private _pipeline?: WebGl2RenderPipeline;
  private readonly _groups: (WebGl2BindGroup | undefined)[] = [];
  private readonly _vertexBuffers: (WebGl2Buffer | undefined)[] = [];
  private _indexBuffer?: { buffer: WebGl2Buffer; type: GLenum };

  constructor(private readonly _commands: Command[]) {}

  setPipeline(pipeline: GpuRenderPipeline): void {
    this._pipeline = unwrap(pipeline, WebGl2RenderPipeline, 'The pipeline');
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

  draw(vertexCount: number, instanceCount = 1): void {
    const state = this.state();
    this._commands.push((gl) => {
      this.prepare(gl, state);
      gl.drawArraysInstanced(
        state.pipeline.topology,
        0,
        vertexCount,
        instanceCount
      );
    });
  }

  drawIndexed(indexCount: number, instanceCount = 1): void {
    const state = this.state();
    const index = state.indexBuffer;
    if (!index) {
      throw new Error('drawIndexed needs an index buffer');
    }
    this._commands.push((gl) => {
      this.prepare(gl, state);
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
    this._commands.push((gl) => {
      gl.bindVertexArray(null);
    });
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
    if (descriptor.colorAttachments.length !== 1) {
      throw new Error('The WebGL2 backend renders to one color target');
    }
    const [color] = descriptor.colorAttachments;
    const target = unwrap(color.target, WebGl2RenderTarget, 'The color target');
    const depth = descriptor.depthAttachment;
    const depthTarget = depth
      ? unwrap(depth.target, WebGl2RenderTarget, 'The depth target')
      : undefined;

    this._commands.push((gl) => {
      gl.bindFramebuffer(GL.FRAMEBUFFER, target.framebuffer(depthTarget));
      gl.viewport(0, 0, target.width, target.height);
      gl.disable(GL.SCISSOR_TEST);
      let mask = 0;
      if (color.load === 'clear') {
        const { r, g, b, a } = color.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
        gl.colorMask(true, true, true, true);
        gl.clearColor(r, g, b, a);
        mask |= GL.COLOR_BUFFER_BIT;
      }
      if (depth?.load === 'clear') {
        // The depth mask also applies to clears.
        gl.depthMask(true);
        gl.clearDepth(depth.clearValue ?? 1);
        mask |= GL.DEPTH_BUFFER_BIT;
        if (depth.target.format.includes('stencil')) {
          gl.clearStencil(0);
          mask |= GL.STENCIL_BUFFER_BIT;
        }
      }
      if (mask) {
        gl.clear(mask);
      }
    });
    return new WebGl2RenderPassEncoder(this._commands);
  }

  finish(): GpuCommandBuffer {
    return new WebGl2CommandBuffer([...this._commands]);
  }
}
