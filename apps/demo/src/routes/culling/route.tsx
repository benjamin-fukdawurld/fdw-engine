import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import { Engine, Surface } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

import { mat4 } from 'wgpu-matrix';

import wgsl from './shader.wgsl?raw';

export const Route = createFileRoute('/culling')({
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

        const response = await fetch('/images/wall.jpg');
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);

        const texture = wengine.device!.createTexture({
          size: { width: imageBitmap.width, height: imageBitmap.height },
          format: 'rgba8unorm',
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        wengine.device!.queue.copyExternalImageToTexture(
          { source: imageBitmap },
          { texture },
          { width: imageBitmap.width, height: imageBitmap.height }
        );

        const sampler = wengine.device!.createSampler({
          addressModeU: 'repeat',
          addressModeV: 'repeat',
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear',
        });

        const vertexData = new Float32Array([
          ...[-0.5, -0.5, 0.0], // bottom left vertex
          ...[0.0, 0.0], // bottom left vertex UV
          ...[0.5, -0.5, 0.0], // bottom right vertex
          ...[1.0, 0.0], // bottom right vertex UV
          ...[-0.5, 0.5, 0.0], // top left vertex
          ...[0.0, 1], // top left vertex UV
          ...[0.5, 0.5, 0.0], // top right vertex
          ...[1.0, 1.0], // top right vertex UV
        ]);

        const positionColorBufferAttributeDesc: GPUVertexBufferLayout = {
          arrayStride: 5 * 4, // 3 floats for position + 2 floats for UV, 4 bytes per float
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' },
          ],
        };

        const vertexDataBuffer = wengine.device!.createBuffer({
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(vertexDataBuffer.getMappedRange()).set(vertexData);
        vertexDataBuffer.unmap();

        const offsetData = new Float32Array([0.5, 0.0, 0.0]); // Offset to the right

        const offsetBuffer = wengine.device!.createBuffer({
          size: offsetData.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(offsetBuffer.getMappedRange()).set(offsetData);
        offsetBuffer.unmap();

        const modelMatrix = mat4.translate(mat4.identity(), [-0.25, 0.0, 0.0]);
        const modelMatrixBuffer = wengine.device!.createBuffer({
          size: 16 * 4, // 4x4 matrix, 4 bytes per float
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(modelMatrixBuffer.getMappedRange()).set(modelMatrix);
        modelMatrixBuffer.unmap();

        const viewMatrix = mat4.inverse(
          mat4.lookAt(
            [0.0, 0.0, 2.0], // Camera position
            [0.0, 0.0, 0.0], // Look at point
            [0.0, 1.0, 0.0] // Up vector
          )
        );
        const viewMatrixBuffer = wengine.device!.createBuffer({
          size: 16 * 4, // 4x4 matrix, 4 bytes per float
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(viewMatrixBuffer.getMappedRange()).set(viewMatrix);
        viewMatrixBuffer.unmap();

        const projectionMatrix = mat4.perspective(
          (45 * Math.PI) / 180, // Field of view in radians
          wsurface.width / wsurface.height, // Aspect ratio
          0.1, // Near plane
          100.0 // Far plane
        );
        const projectionMatrixBuffer = wengine.device!.createBuffer({
          size: 16 * 4, // 4x4 matrix, 4 bytes per float
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(projectionMatrixBuffer.getMappedRange()).set(
          projectionMatrix
        );
        projectionMatrixBuffer.unmap();

        const uniformBindGroupLayout = wengine.device!.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              texture: {},
            },
            {
              binding: 2,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: {},
            },
            {
              binding: 3,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 4,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 5,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
          ],
        });

        const uniformBindGroup = wengine.device!.createBindGroup({
          layout: uniformBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: offsetBuffer,
              },
            },
            {
              binding: 1,
              resource: texture.createView(),
            },
            {
              binding: 2,
              resource: sampler,
            },
            {
              binding: 3,
              resource: {
                buffer: modelMatrixBuffer,
              },
            },
            {
              binding: 4,
              resource: {
                buffer: viewMatrixBuffer,
              },
            },
            {
              binding: 5,
              resource: {
                buffer: projectionMatrixBuffer,
              },
            },
          ],
        });

        const shaderModule = wengine.device!.createShaderModule({
          code: wgsl,
        });

        const pipelineLayout = wengine.device!.createPipelineLayout({
          bindGroupLayouts: [uniformBindGroupLayout],
        });

        const pipeline = wengine.device!.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [positionColorBufferAttributeDesc],
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
            topology: 'triangle-strip',
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
        passEncoder.setVertexBuffer(0, vertexDataBuffer);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.draw(4, 1);
        passEncoder.end();

        wengine.device!.queue.submit([commandEncoder.finish()]);
      }}
    />
  );
}
