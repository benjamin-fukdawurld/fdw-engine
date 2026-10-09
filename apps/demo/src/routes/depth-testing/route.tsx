import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import { Engine, Surface } from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

import { mat4 } from 'wgpu-matrix';

import wgsl from './shader.wgsl?raw';
import { useState } from 'react';

export const Route = createFileRoute('/depth-testing')({
  component: RouteComponent,
});

const cubeVertices = new Float32Array([
  // Front face
  ...[-0.5, -0.5, 0.5], // Bottom left
  ...[1.0, 0.0, 0.0], // Color red
  ...[0.5, -0.5, 0.5], // Bottom right
  ...[1.0, 0.0, 0.0], // Color red
  ...[-0.5, 0.5, 0.5], // Top left
  ...[1.0, 0.0, 0.0], // Color red
  ...[0.5, 0.5, 0.5], // Top right
  ...[1.0, 0.0, 0.0], // Color red

  // Back face
  ...[0.5, -0.5, -0.5], // Bottom right
  ...[0.0, 1.0, 0.0], // Color green
  ...[-0.5, -0.5, -0.5], // Bottom left
  ...[0.0, 1.0, 0.0], // Color green
  ...[0.5, 0.5, -0.5], // Top right
  ...[0.0, 1.0, 0.0], // Color green
  ...[-0.5, 0.5, -0.5], // Top left
  ...[0.0, 1.0, 0.0], // Color green

  // Left face
  ...[-0.5, -0.5, -0.5], // Bottom left
  ...[0.0, 0.0, 1.0], // Color blue
  ...[-0.5, -0.5, 0.5], // Bottom right
  ...[0.0, 0.0, 1.0], // Color blue
  ...[-0.5, 0.5, -0.5], // Top left
  ...[0.0, 0.0, 1.0], // Color blue
  ...[-0.5, 0.5, 0.5], // Top right
  ...[0.0, 0.0, 1.0], // Color blue

  // Right face
  ...[0.5, -0.5, 0.5], // Bottom left
  ...[1.0, 1.0, 0.0], // Color yellow
  ...[0.5, -0.5, -0.5], // Bottom right
  ...[1.0, 1.0, 0.0], // Color yellow
  ...[0.5, 0.5, 0.5], // Top left
  ...[1.0, 1.0, 0.0], // Color yellow
  ...[0.5, 0.5, -0.5], // Top right
  ...[1.0, 1.0, 0.0], // Color yellow

  // Top face
  ...[-0.5, 0.5, 0.5], // Bottom left
  ...[1.0, 0.0, 1.0], // Color magenta
  ...[0.5, 0.5, 0.5], // Bottom right
  ...[1.0, 0.0, 1.0], // Color magenta
  ...[-0.5, 0.5, -0.5], // Top left
  ...[1.0, 0.0, 1.0], // Color magenta
  ...[0.5, 0.5, -0.5], // Top right
  ...[1.0, 0.0, 1.0], // Color magenta

  // Bottom face
  ...[0.5, -0.5, 0.5], // Bottom right
  ...[0.0, 1.0, 1.0], // Color cyan
  ...[-0.5, -0.5, 0.5], // Bottom left
  ...[0.0, 1.0, 1.0], // Color cyan
  ...[0.5, -0.5, -0.5], // Top right
  ...[0.0, 1.0, 1.0], // Color cyan
  ...[-0.5, -0.5, -0.5], // Top left
  ...[0.0, 1.0, 1.0], // Color cyan
]);

const cubeIndices = new Uint16Array([
  // Front face
  0, 1, 2, 2, 1, 3,

  // Back face
  4, 5, 6, 6, 5, 7,

  // Left face
  8, 9, 10, 10, 9, 11,

  // Right face
  12, 13, 14, 14, 13, 15,

  // Top face
  16, 17, 18, 18, 17, 19,

  // Bottom face
  20, 21, 22, 22, 21, 23,
]);

function RouteComponent() {
  const [rotation] = useState<[number, number]>([0, 0]);

  return (
    <Layout
      onSurfaceReady={async (
        engine: Engine,
        surface: Surface,
        canvas: HTMLCanvasElement
      ) => {
        const wengine = engine as WebGpuEngine;
        const wsurface = surface as WebGpuSurface;

        const positionColorBufferAttributeDesc: GPUVertexBufferLayout = {
          arrayStride: 6 * 4, // 3 floats for position + 3 floats for color
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
          ],
        };

        const vertexDataBuffer = wengine.device!.createBuffer({
          size: cubeVertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(vertexDataBuffer.getMappedRange()).set(cubeVertices);
        vertexDataBuffer.unmap();

        const indexDataBuffer = wengine.device!.createBuffer({
          size: cubeIndices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Uint16Array(indexDataBuffer.getMappedRange()).set(cubeIndices);
        indexDataBuffer.unmap();

        const offsetData = new Float32Array([0.5, 0.0, 0.0]); // Offset to the right

        const offsetBuffer = wengine.device!.createBuffer({
          size: offsetData.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(offsetBuffer.getMappedRange()).set(offsetData);
        offsetBuffer.unmap();

        let modelMatrix = mat4.translate(mat4.identity(), [-0.25, 0.0, 0.0]);
        modelMatrix = mat4.rotateY(modelMatrix, rotation[0]);
        modelMatrix = mat4.rotateX(modelMatrix, rotation[1]);
        const modelMatrixBuffer = wengine.device!.createBuffer({
          size: 16 * 4, // 4x4 matrix, 4 bytes per float
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Float32Array(modelMatrixBuffer.getMappedRange()).set(modelMatrix);
        modelMatrixBuffer.unmap();

        const viewMatrix = mat4.lookAt(
          [1.0, 1.0, 2.0], // Camera position
          [0.0, 0.0, 0.0], // Look at point
          [0.0, 1.0, 0.0] // Up vector
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

        const depthTextureDesc: GPUTextureDescriptor = {
          size: [wsurface.width, wsurface.height, 1],
          format: 'depth24plus-stencil8',
          dimension: '2d',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        };
        const depthTexture = wengine.device!.createTexture(depthTextureDesc);

        const uniformBindGroupLayout = wengine.device!.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 1,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 2,
              visibility: GPUShaderStage.VERTEX,
              buffer: {},
            },
            {
              binding: 3,
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
              resource: {
                buffer: modelMatrixBuffer,
              },
            },
            {
              binding: 2,
              resource: {
                buffer: viewMatrixBuffer,
              },
            },
            {
              binding: 3,
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
            topology: 'triangle-list',
            frontFace: 'ccw',
            cullMode: 'none',
          },
          depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus-stencil8',
          },
        });

        const commandEncoder = wengine.device!.createCommandEncoder();

        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [wsurface.colorAttachment],
          depthStencilAttachment: {
            view: depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'store',
          },
        });
        passEncoder.setViewport(0, 0, wsurface.width, wsurface.height, 0, 1);
        passEncoder.setPipeline(pipeline);
        passEncoder.setVertexBuffer(0, vertexDataBuffer);
        passEncoder.setIndexBuffer(indexDataBuffer, 'uint16');
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.drawIndexed(cubeIndices.length, 1, 0, 0, 0);
        passEncoder.end();

        wengine.device!.queue.submit([commandEncoder.finish()]);
      }}
    />
  );
}
