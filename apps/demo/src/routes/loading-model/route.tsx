import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import {
  CameraAdapter,
  Engine,
  Surface,
  TransformAdapter,
} from '@fdw/engine-backend';
import {
  transformMath,
  cameraMath,
  WebGpuEngine,
  WebGpuSurface,
  BufferFactory,
  Buffer,
} from '@fdw/engine-webgpu';

import { quat, vec3 } from 'wgpu-matrix';

import wgsl from './shader.wgsl?raw';
import { useRef } from 'react';

import { Camera, Transform } from '@fdw/engine-core';

import { ObjImporter } from './obj-importer';

export const Route = createFileRoute('/loading-model')({
  component: RouteComponent,
});

function RouteComponent() {
  const cameraRef = useRef<Camera | null>(null);
  const bufferFactoryRef = useRef<BufferFactory | null>(null);
  const cameraAdapterRef = useRef<CameraAdapter | null>(null);
  const transformAdapterRef = useRef<TransformAdapter | null>(null);

  return (
    <Layout
      onSurfaceReady={async (engine: Engine, surface: Surface) => {
        const wengine = engine as WebGpuEngine;
        const wsurface = surface as WebGpuSurface;
        bufferFactoryRef.current = new BufferFactory(wengine.device!);

        const obj = await ObjImporter.load('/cube.obj');
        console.log('Loaded OBJ:', obj);
        const cubeVertices = new Float32Array(obj[0].vertices);
        const cubeIndices = new Uint16Array(obj[0].indices);
        const q = quat.rotationTo(
          vec3.normalize([1, 1, 2]),
          vec3.normalize([3, 3, 2])
        );
        cameraRef.current = new Camera({
          position: { x: 1, y: 1, z: 2 },
          rotation: { x: q[0], y: q[1], z: q[2], w: q[3] },
          projection: {
            type: 'perspective',
            fov: 45,
            aspect: wsurface.width / wsurface.height,
            near: 0.1,
            far: 100.0,
          },
        });
        cameraAdapterRef.current = new CameraAdapter({
          camera: cameraRef.current!,
          cameraMath,
          bufferFactory: bufferFactoryRef.current!,
        });
        transformAdapterRef.current = new TransformAdapter({
          transform: new Transform(),
          transformMath,
          bufferFactory: bufferFactoryRef.current!,
        });

        const positionColorBufferAttributeDesc: GPUVertexBufferLayout = {
          arrayStride: 8 * 4, // 3 floats for position + 3 floats for normal + 2 floats for UV
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' },
            { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' },
          ],
        };

        const vertexDataBuffer = bufferFactoryRef.current!.create({
          size: cubeVertices.byteLength,
          usage: ['vertex', 'copy-dst'],
          initialData: cubeVertices,
          label: 'Cube Vertex Data Buffer',
        });

        const indexDataBuffer = bufferFactoryRef.current!.create({
          size: cubeIndices.byteLength,
          usage: ['index', 'copy-dst'],
          initialData: cubeIndices,
          label: 'Cube Index Data Buffer',
        });

        const offsetData = new Float32Array([0.5, 0.0, 0.0]); // Offset to the right

        const offsetBuffer = bufferFactoryRef.current!.create({
          size: offsetData.byteLength,
          usage: ['uniform', 'copy-dst'],
          initialData: offsetData,
          label: 'Offset Data Buffer',
        });

        const modelMatrixBuffer =
          transformAdapterRef.current!.localMatrixBuffer.value!;

        const viewMatrixBuffer = cameraAdapterRef.current!.viewMatrixBuffer;
        const projectionMatrixBuffer =
          cameraAdapterRef.current!.projectionMatrixBuffer;

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
                buffer: offsetBuffer.buffer,
              },
            },
            {
              binding: 1,
              resource: {
                buffer: (modelMatrixBuffer as Buffer).buffer,
              },
            },
            {
              binding: 2,
              resource: {
                buffer: (viewMatrixBuffer.value as Buffer).buffer,
              },
            },
            {
              binding: 3,
              resource: {
                buffer: (projectionMatrixBuffer.value as Buffer).buffer,
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
        passEncoder.setVertexBuffer(0, vertexDataBuffer.buffer);
        passEncoder.setIndexBuffer(indexDataBuffer.buffer, 'uint16');
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.drawIndexed(cubeIndices.length, 1, 0, 0, 0);
        passEncoder.end();

        wengine.device!.queue.submit([commandEncoder.finish()]);
      }}
    />
  );
}
