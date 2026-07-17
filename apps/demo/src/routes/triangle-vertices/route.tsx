import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import { Engine, Surface } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

import wgsl from './shader.wgsl?raw';

export const Route = createFileRoute('/triangle-vertices')({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <Layout
      onSurfaceReady={async (
        engine: Engine,
        surface: Surface,
        canvas: HTMLCanvasElement
      ) => {
        const wengine = engine as WebGpuEngine;
        const wsurface = surface as WebGpuSurface;

        const vertexData = new Float32Array([
          ...[0.0, 0.5, 0.0], // top vertex
          ...[-0.5, -0.5, 0.0], // bottom left vertex
          ...[0.5, -0.5, 0.0], // bottom right vertex
        ]);

        const positionAttributeDesc: GPUVertexBufferLayout = {
          arrayStride: 3 * 4, // 3 floats per vertex, 4 bytes per float
          stepMode: 'vertex',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        };

        const vertexBuffer = wengine.device!.createBuffer({
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
        vertexBuffer.unmap();

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
            buffers: [positionAttributeDesc],
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
        passEncoder.setVertexBuffer(0, vertexBuffer);
        passEncoder.draw(3, 1);
        passEncoder.end();

        wengine.device!.queue.submit([commandEncoder.finish()]);
      }}
    />
  );
}
