import type {
  GpuAttachmentTarget,
  GpuBindGroup,
  GpuBuffer,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuComputePassEncoder,
  GpuComputePipeline,
  GpuRenderPassEncoder,
  GpuRenderPipeline,
  IndexFormat,
  PassTiming,
  RenderPassDescriptor,
} from '@fdw/engine-backend';
import { Commands } from '../addon';
import { VulkanBuffer } from '../gpu/VulkanBuffer';
import { VulkanTexture } from '../gpu/VulkanTexture';
import {
  VulkanBindGroup,
  VulkanComputePipeline,
  VulkanRenderPipeline,
} from './VulkanPipelineFactory';
import { VulkanPassTimer } from './VulkanPassTimer';

// The commands of a submission, as 32-bit words (see FDW_VK_CMD_* of
// include/fdw/vulkan.h): replayed by the native library at submit.
export class CommandWriter {
  private _words = new Uint32Array(256);
  private _floats = new Float32Array(this._words.buffer);
  private _length = 0;

  word(value: number): this {
    this.reserve(1);
    this._words[this._length++] = value;
    return this;
  }

  real(value: number): this {
    this.reserve(1);
    this._floats[this._length++] = value;
    return this;
  }

  // A 64-bit value: low, then high word.
  wide(value: number): this {
    return this.word(value % 2 ** 32).word(Math.floor(value / 2 ** 32));
  }

  /** The words written, copied. */
  finish(): Uint32Array {
    return this._words.slice(0, this._length);
  }

  private reserve(count: number): void {
    if (this._length + count <= this._words.length) {
      return;
    }
    const grown = new Uint32Array(
      Math.max(this._words.length * 2, this._length + count)
    );
    grown.set(this._words.subarray(0, this._length));
    this._words = grown;
    this._floats = new Float32Array(grown.buffer);
  }
}

export function unwrap<T>(
  value: unknown,
  type: abstract new (...args: never[]) => T,
  what: string
): T {
  if (!(value instanceof type)) {
    throw new Error(`${what} was not created by the Vulkan backend`);
  }
  return value;
}

const target = (value: GpuAttachmentTarget | undefined, what: string) =>
  value === undefined ? 0 : unwrap(value, VulkanTexture, what).id;

/** The commands of a submission, given to the backend. */
export class VulkanCommandBuffer {
  constructor(readonly words: Uint32Array) {}
}

class VulkanRenderPassEncoder implements GpuRenderPassEncoder {
  constructor(
    private readonly _writer: CommandWriter,
    // Written after the pass: the timestamp of its end.
    private readonly _onEnd?: () => void
  ) {}

  setPipeline(pipeline: GpuRenderPipeline): void {
    this._writer
      .word(Commands.setPipeline)
      .word(unwrap(pipeline, VulkanRenderPipeline, 'The pipeline').id);
  }

  setBindGroup(index: number, group: GpuBindGroup): void {
    this._writer
      .word(Commands.setGroup)
      .word(index)
      .word(unwrap(group, VulkanBindGroup, 'The bind group').id);
  }

  setVertexBuffer(slot: number, buffer: GpuBuffer): void {
    this._writer
      .word(Commands.setVertexBuffer)
      .word(slot)
      .word(unwrap(buffer, VulkanBuffer, 'The vertex buffer').id);
  }

  setIndexBuffer(buffer: GpuBuffer, format: IndexFormat): void {
    this._writer
      .word(Commands.setIndexBuffer)
      .word(unwrap(buffer, VulkanBuffer, 'The index buffer').id)
      .word(format === 'uint16' ? 0 : 1);
  }

  draw(vertexCount: number, instanceCount = 1, firstInstance = 0): void {
    this._writer
      .word(Commands.draw)
      .word(vertexCount)
      .word(instanceCount)
      .word(firstInstance);
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstInstance = 0): void {
    this._writer
      .word(Commands.drawIndexed)
      .word(indexCount)
      .word(instanceCount)
      .word(firstInstance);
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    this._writer
      .word(Commands.setViewport)
      .real(x)
      .real(y)
      .real(width)
      .real(height);
  }

  end(): void {
    this._writer.word(Commands.endRenderPass);
    this._onEnd?.();
  }
}

class VulkanComputePassEncoder implements GpuComputePassEncoder {
  constructor(
    private readonly _writer: CommandWriter,
    // Written after the pass: the timestamp of its end.
    private readonly _onEnd?: () => void
  ) {}

  setPipeline(pipeline: GpuComputePipeline): void {
    this._writer
      .word(Commands.setPipeline)
      .word(unwrap(pipeline, VulkanComputePipeline, 'The pipeline').id);
  }

  setBindGroup(index: number, group: GpuBindGroup): void {
    this._writer
      .word(Commands.setGroup)
      .word(index)
      .word(unwrap(group, VulkanBindGroup, 'The bind group').id);
  }

  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this._writer.word(Commands.dispatch).word(x).word(y).word(z);
  }

  dispatchWorkgroupsIndirect(buffer: GpuBuffer, offset: number): void {
    this._writer
      .word(Commands.dispatchIndirect)
      .word(unwrap(buffer, VulkanBuffer, 'The indirect buffer').id)
      .wide(offset);
  }

  end(): void {
    this._writer.word(Commands.endComputePass);
    this._onEnd?.();
  }
}

// Records commands as words; the native library replays them, with the
// barriers the resources need, at submit.
export class VulkanCommandEncoder implements GpuCommandEncoder {
  private readonly _writer = new CommandWriter();

  beginRenderPass(descriptor: RenderPassDescriptor): GpuRenderPassEncoder {
    const writer = this._writer;
    const onEnd = this.timestamp(descriptor.timing);
    writer
      .word(Commands.beginRenderPass)
      .word(descriptor.colorAttachments.length);
    for (const color of descriptor.colorAttachments) {
      const { r, g, b, a } = color.clearValue ?? { r: 0, g: 0, b: 0, a: 1 };
      writer
        .word(target(color.target, 'The color target'))
        .word(color.load === 'clear' ? 0 : 1)
        .real(r)
        .real(g)
        .real(b)
        .real(a)
        .word(target(color.resolveTarget, 'The resolve target'));
    }
    const depth = descriptor.depthAttachment;
    writer
      .word(target(depth?.target, 'The depth target'))
      .word(depth?.load === 'load' ? 1 : 0)
      .real(depth?.clearValue ?? 1);
    return new VulkanRenderPassEncoder(writer, onEnd);
  }

  beginComputePass(
    _label?: string,
    timing?: PassTiming
  ): GpuComputePassEncoder {
    const onEnd = this.timestamp(timing);
    this._writer.word(Commands.beginComputePass);
    return new VulkanComputePassEncoder(this._writer, onEnd);
  }

  // A measured pass: the timestamp of its beginning, now (before the pass),
  // and what writes the one of its end.
  private timestamp(timing: PassTiming | undefined): (() => void) | undefined {
    if (!timing) {
      return undefined;
    }
    const timer = unwrap(timing.timer, VulkanPassTimer, 'The pass timer');
    if (!timer.write(this._writer, timing.index, false)) {
      return undefined;
    }
    return () => timer.write(this._writer, timing.index, true);
  }

  copyBufferToBuffer(
    source: GpuBuffer,
    sourceOffset: number,
    destination: GpuBuffer,
    destinationOffset: number,
    size: number
  ): void {
    this._writer
      .word(Commands.copyBuffer)
      .word(unwrap(source, VulkanBuffer, 'The source buffer').id)
      .wide(sourceOffset)
      .word(unwrap(destination, VulkanBuffer, 'The destination buffer').id)
      .wide(destinationOffset)
      .wide(size);
  }

  copyTextureToTexture(
    source: GpuAttachmentTarget,
    destination: GpuAttachmentTarget,
    size: { readonly width: number; readonly height: number }
  ): void {
    this._writer
      .word(Commands.copyTexture)
      .word(target(source, 'The source texture'))
      .word(target(destination, 'The destination texture'))
      .word(size.width)
      .word(size.height);
  }

  finish(): GpuCommandBuffer {
    return new VulkanCommandBuffer(this._writer.finish());
  }
}
