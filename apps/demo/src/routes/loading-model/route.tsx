import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import {
  CameraAdapter,
  CameraSnapshot,
  Engine,
  Mat3,
  Surface,
  TransformAdapter,
  TransformSnapshot,
} from '@fdw/engine-backend';
import { WebGpuEngine, WebGpuSurface } from '@fdw/engine-webgpu';

import { mat3, Mat4, mat4, quat, vec3 } from 'wgpu-matrix';

import wgsl from './shader.wgsl?raw';
import { useRef, useState } from 'react';

import { Camera, Transform } from '@fdw/engine-core';

export const Route = createFileRoute('/loading-model')({
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

function getViewMatrix(camera: CameraSnapshot): Mat4 {
  const worldMatrix = mat4.multiply(
    mat4.translate(mat4.identity(), [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ]),
    mat4.fromQuat([
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z,
      camera.rotation.w,
    ])
  );

  return mat4.invert(worldMatrix);
}

function getProjectionMatrix(camera: CameraSnapshot): Mat4 {
  if (camera.projection.type === 'perspective') {
    return mat4.perspective(
      (camera.projection.fov * Math.PI) / 180,
      camera.projection.aspect,
      camera.projection.near,
      camera.projection.far
    );
  }

  return mat4.ortho(
    camera.projection.left,
    camera.projection.right,
    camera.projection.bottom,
    camera.projection.top,
    camera.projection.near,
    camera.projection.far
  );
}

function getLocalMatrix(transform: TransformSnapshot): Mat4 {
  const translationMatrix = mat4.translate(mat4.identity(), [
    transform.position.x,
    transform.position.y,
    transform.position.z,
  ]);
  const rotationMatrix = mat4.fromQuat([
    transform.rotation.x,
    transform.rotation.y,
    transform.rotation.z,
    transform.rotation.w,
  ]);
  const scaleMatrix = mat4.scale(mat4.identity(), [
    transform.scale.x,
    transform.scale.y,
    transform.scale.z,
  ]);

  return mat4.multiply(
    translationMatrix,
    mat4.multiply(rotationMatrix, scaleMatrix)
  );
}

function getInverseLocalMatrix(localMatrix: Mat4): Mat4 {
  return mat4.invert(localMatrix);
}

function getLocalNormalMatrix(localMatrix: Mat4): Mat3 {
  const normalMatrix = mat4.invert(localMatrix);
  return mat3.fromMat4(normalMatrix);
}

function getWorldMatrix(localMatrix: Mat4, parentWorldMatrix?: Mat4): Mat4 {
  if (parentWorldMatrix) {
    return mat4.multiply(parentWorldMatrix, localMatrix);
  }
  return localMatrix;
}

function getWorldNormalMatrix(
  normalMatrix: Mat3,
  parentWorldNormalMatrix?: Mat3
): Mat3 {
  if (parentWorldNormalMatrix) {
    return mat3.multiply(parentWorldNormalMatrix, normalMatrix);
  }
  return normalMatrix;
}

function getViewProjectionMatrix(
  viewMatrix: Mat4,
  projectionMatrix: Mat4
): Mat4 {
  return mat4.multiply(projectionMatrix, viewMatrix);
}

function webGpuWriteBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  data: Float32Array | Uint16Array | Uint32Array,
  options?: { bufferOffset?: number; dataOffset?: number; size?: number }
): void {
  device.queue.writeBuffer(
    buffer,
    options?.bufferOffset ?? 0,
    data,
    options?.dataOffset ?? 0,
    options?.size
  );
}

function webGpuCreateBuffer(
  device: GPUDevice,
  usage: GPUBufferUsageFlags,
  options: { data?: Float32Array | Uint16Array | Uint32Array; size?: number }
): GPUBuffer {
  const size = options.size ?? options.data?.byteLength;
  if (size === undefined) {
    throw new Error('Size must be specified if data is not provided.');
  }

  const data = options.data;
  const buffer = device.createBuffer({
    size,
    usage,
    mappedAtCreation: data !== undefined, // Map the buffer if data is provided
  });

  if (data) {
    const arrayBuffer = buffer.getMappedRange();
    if (data instanceof Float32Array) {
      new Float32Array(arrayBuffer).set(data);
    } else if (data instanceof Uint16Array) {
      new Uint16Array(arrayBuffer).set(data);
    } else if (data instanceof Uint32Array) {
      new Uint32Array(arrayBuffer).set(data);
    }
    buffer.unmap();
  }
  return buffer;
}

function RouteComponent() {
  const [rotation, setRotation] = useState<[number, number]>([0, 0]);
  const cameraRef = useRef<Camera | null>(null);
  const cameraAdapterRef = useRef<CameraAdapter<GPUBuffer> | null>(null);
  const transformAdapterRef = useRef<TransformAdapter<GPUBuffer> | null>(null);

  return (
    <Layout
      onSurfaceReady={async (
        engine: Engine,
        surface: Surface,
        canvas: HTMLCanvasElement
      ) => {
        const wengine = engine as WebGpuEngine;
        const wsurface = surface as WebGpuSurface;
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
        cameraAdapterRef.current = new CameraAdapter<GPUBuffer>({
          camera: cameraRef.current!,
          createMatrixBufferStrategy: () => {
            return webGpuCreateBuffer(
              wengine.device!,
              GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              {
                size: 16 * 4, // 4x4 matrix, 4 bytes per float
              }
            );
          },
          writeMatrixBufferStrategy: (buffer: unknown, data: Mat4) => {
            if (!(buffer instanceof GPUBuffer)) {
              throw new Error(
                'Expected buffer to be an instance of GPUBuffer.'
              );
            }
            webGpuWriteBuffer(wengine.device!, buffer, new Float32Array(data));

            return buffer;
          },
          viewMatrixStrategy: getViewMatrix,
          projectionMatrixStrategy: getProjectionMatrix,
          viewProjectionMatrixStrategy: getViewProjectionMatrix,
        });
        transformAdapterRef.current = new TransformAdapter<GPUBuffer>({
          transform: new Transform(),
          createMatrixBufferStrategy: (type) => {
            return webGpuCreateBuffer(
              wengine.device!,
              GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              {
                size: 16 * 4, // 4x4 matrix, 4 bytes per float
              }
            );
          },
          writeMatrixBufferStrategy: (buffer, type, data) => {
            if (!(buffer instanceof GPUBuffer)) {
              throw new Error(
                'Expected buffer to be an instance of GPUBuffer.'
              );
            }
            if (type === 'mat4') {
              webGpuWriteBuffer(
                wengine.device!,
                buffer,
                new Float32Array(data as Mat4)
              );
            } else if (type === 'mat3') {
              webGpuWriteBuffer(
                wengine.device!,
                buffer,
                new Float32Array(
                  data.reduce((acc, val, index) => {
                    acc.push(val);
                    if ((index + 1) % 3 === 0) {
                      acc.push(0); // Add a 0 for the fourth column
                    }

                    return acc;
                  }, [] as number[])
                )
              );
            } else {
              throw new Error(`Unsupported buffer type: ${type}`);
            }
          },
          localMatrixStrategy: getLocalMatrix,
          inverseLocalMatrixStrategy: getInverseLocalMatrix,
          normalMatrixStrategy: getLocalNormalMatrix,
          worldMatrixStrategy: getWorldMatrix,
          worldNormalMatrixStrategy: getWorldNormalMatrix,
        });

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
                buffer: viewMatrixBuffer.value,
              },
            },
            {
              binding: 3,
              resource: {
                buffer: projectionMatrixBuffer.value,
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
