import {
  BackendCapabilities,
  CameraMath,
  GpuCommandBuffer,
  GpuCommandEncoder,
  GpuPassTimer,
  ObjectTableDescriptor,
  RenderBackend,
  RenderTargetDescriptor,
  TransformMath,
  wgpuMatrixPrimitives,
} from '@fdw/engine-backend';
import { GL } from '../gl';
import { glCompressedFormats } from '../gpu/formats';
import { WebGl2BufferFactory } from '../gpu/WebGl2Buffer';
import { maxAnisotropy, WebGl2TextureFactory } from '../gpu/WebGl2Texture';
import {
  WebGl2CommandBuffer,
  WebGl2CommandEncoder,
} from './WebGl2CommandEncoder';
import { WebGl2ObjectTable } from './WebGl2ObjectTable';
import { TimerQueryExtension, WebGl2PassTimer } from './WebGl2PassTimer';
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
      // The object data in data textures.
      objectTable: true,
      compute: false,
      // Float color attachments need EXT_color_buffer_float (enabled by
      // getExtension), widely available on WebGL2.
      renderableFormats: gl.getExtension('EXT_color_buffer_float')
        ? ['rgba16float']
        : [],
      // Those of the extensions the context has, enabled here.
      compressedFormats: glCompressedFormats(gl),
      maxAnisotropy: maxAnisotropy(gl),
      maxColorAttachments: Math.min(
        gl.getParameter(GL.MAX_DRAW_BUFFERS),
        gl.getParameter(GL.MAX_COLOR_ATTACHMENTS)
      ),
      independentBlend: false,
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

  createObjectTable(descriptor: ObjectTableDescriptor): WebGl2ObjectTable {
    return new WebGl2ObjectTable(this.gl, descriptor);
  }

  // Where the browser gives the timer queries.
  createPassTimer(capacity: number): GpuPassTimer | undefined {
    const extension = this.gl.getExtension(
      'EXT_disjoint_timer_query_webgl2'
    ) as TimerQueryExtension | null;
    return extension
      ? new WebGl2PassTimer(this.gl, extension, capacity)
      : undefined;
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
