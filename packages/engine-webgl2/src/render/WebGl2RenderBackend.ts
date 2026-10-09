import {
  BackendCapabilities,
  CameraMath,
  GpuCommandBuffer,
  GpuCommandEncoder,
  RenderBackend,
  RenderTargetDescriptor,
  TransformMath,
  wgpuMatrixPrimitives,
} from '@fdw/engine-backend';
import { GL } from '../gl';
import { WebGl2BufferFactory } from '../gpu/WebGl2Buffer';
import { WebGl2TextureFactory } from '../gpu/WebGl2Texture';
import {
  WebGl2CommandBuffer,
  WebGl2CommandEncoder,
} from './WebGl2CommandEncoder';
import { WebGl2PipelineFactory } from './WebGl2PipelineFactory';
import { WebGl2RenderTarget } from './WebGl2RenderTarget';

// The engine math produces a clip space depth in [0, 1], as in WebGPU: the
// generated vertex shaders remap it to the [-1, 1] range of OpenGL.
const cameraMath = new CameraMath(wgpuMatrixPrimitives);
const transformMath = new TransformMath(wgpuMatrixPrimitives);

export class WebGl2RenderBackend implements RenderBackend {
  readonly buffers: WebGl2BufferFactory;
  readonly textures: WebGl2TextureFactory;
  readonly pipelines: WebGl2PipelineFactory;
  readonly cameraMath = cameraMath;
  readonly transformMath = transformMath;
  readonly depthFormat = 'depth24plus';
  readonly capabilities: BackendCapabilities;

  constructor(readonly gl: WebGL2RenderingContext) {
    this.buffers = new WebGl2BufferFactory(gl);
    this.textures = new WebGl2TextureFactory(gl);
    this.pipelines = new WebGl2PipelineFactory(gl);
    this.capabilities = {
      maxVaryings: gl.getParameter(GL.MAX_VARYING_VECTORS),
      storageBuffers: false,
      compute: false,
      // Float color attachments need EXT_color_buffer_float (enabled by
      // getExtension), widely available on WebGL2.
      renderableFormats: gl.getExtension('EXT_color_buffer_float')
        ? ['rgba16float']
        : [],
    };
  }

  createRenderTarget({
    width,
    height,
    format,
    label,
  }: RenderTargetDescriptor): WebGl2RenderTarget {
    return new WebGl2RenderTarget(this.gl, width, height, format, label);
  }

  createCommandEncoder(): GpuCommandEncoder {
    return new WebGl2CommandEncoder();
  }

  submit(commands: readonly GpuCommandBuffer[]): void {
    for (const command of commands) {
      if (!(command instanceof WebGl2CommandBuffer)) {
        throw new Error(
          'The command buffer was not created by the WebGL2 backend'
        );
      }
      command.execute(this.gl);
    }
  }
}
