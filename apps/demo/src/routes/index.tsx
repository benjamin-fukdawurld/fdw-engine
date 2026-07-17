import { createFileRoute } from '@tanstack/react-router';
import Layout from '../components/Layout';
import { Engine, Surface } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

export const Route = createFileRoute('/')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <Layout
      onSurfaceReady={(
        engine: Engine,
        surface: Surface,
        canvas: HTMLCanvasElement
      ) => {
        const wgsl = `struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
};
 
@vertex
fn vs_main(
    @builtin(vertex_index) in_vertex_index: u32,
) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(1 - i32(in_vertex_index)) * 0.5;
    let y = f32(i32(in_vertex_index & 1u) * 2 - 1) * 0.5;
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    return out;
}
 
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(0.3, 0.2, 0.1, 1.0);
}`;

        const wengine = engine as WebGpuEngine;
        const wsurface = surface as WebGpuSurface;

        const shaderModule = wengine.device!.createShaderModule({
          code: wgsl,
        });

        const pipelineLayout = wengine.device!.createPipelineLayout({
          bindGroupLayouts: [],
        });

        const pipeline = wengine.device!.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [
              {
                format: wsurface.textureFormat!,
              },
            ],
          },
          primitive: {
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'back',
          },
        });

        const commandEncoder = wengine.device!.createCommandEncoder();

        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [wsurface.colorAttachment],
        });
        passEncoder.setViewport(0, 0, wsurface.width, wsurface.height, 0, 1);
        passEncoder.setPipeline(pipeline);
        passEncoder.draw(3, 1);
        passEncoder.end();

        wengine.device!.queue.submit([commandEncoder.finish()]);
      }}
    />
  );
}
