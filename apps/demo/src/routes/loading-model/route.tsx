import { createFileRoute } from '@tanstack/react-router';
import Layout from '../../components/Layout';
import { Engine, Surface } from '@fdw/engine-backend';
import {
  quat,
  WebGpuEngine,
  WebGpuSurface,
  TextureFactory,
  Texture,
  Sampler,
} from '@fdw/engine-webgpu';

import { useRef } from 'react';

import { Camera } from '@fdw/engine-core';

import {
  ObjImporter,
  Application,
  Scene,
  Mesh,
  Material,
  SceneAdapter,
} from '../../utils3d';

export const Route = createFileRoute('/loading-model')({
  component: RouteComponent,
});

function RouteComponent() {
  const applicationRef = useRef<Application | null>(null);
  const sceneAdapterRef = useRef<SceneAdapter | null>(null);
  const textureFactoryRef = useRef<TextureFactory | null>(null);

  return (
    <Layout
      onSurfaceReady={async (engine: Engine, surface: Surface, canvas) => {
        applicationRef.current = new Application({
          canvas,
          engine: engine as WebGpuEngine,
          surface: surface as WebGpuSurface,
        });
        textureFactoryRef.current = new TextureFactory(
          applicationRef.current!.engine.device!
        );
        const obj = await ObjImporter.load('/sphere.obj');

        // const mat = mtlMaterialToMaterial(obj[0].material!);
        // console.log('MTL:', mat);
        sceneAdapterRef.current = new SceneAdapter({
          scene: new Scene({
            cameras: [
              new Camera({
                position: { x: 0, y: 0, z: 10 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                projection: {
                  type: 'perspective',
                  fov: 45,
                  aspect:
                    applicationRef.current!.surface.width /
                    applicationRef.current!.surface.height,
                  near: 0.1,
                  far: 100.0,
                },
              }),
            ],
            activeCameraIndex: 0,
            meshes: [
              new Mesh({
                data: obj[0],
                material: new Material({
                  type: 'basic',
                  attributes: [
                    { semantic: 'position', format: 'float32x3', offset: 0 },
                    { semantic: 'normal', format: 'float32x3', offset: 3 * 4 },
                    { semantic: 'uv', format: 'float32x2', offset: 6 * 4 },
                  ],
                }),
                bufferFactory: applicationRef.current!.bufferFactory,
              }),
            ],
            bufferFactory: applicationRef.current!.bufferFactory,
          }),
          bufferFactory: applicationRef.current!.bufferFactory,
        });

        const diffuseTexture = async () => {
          const response = await fetch('/sphere-diffuse.png');
          const blob = await response.blob();
          const imageBitmap = await createImageBitmap(blob);

          const texture = textureFactoryRef.current!.createTexture({
            dimensions: {
              width: imageBitmap.width,
              height: imageBitmap.height,
            },
            format: 'rgba8unorm',
            type: '2d',
            source: imageBitmap,
            label: 'diffuseTexture',
            readwrite: true,
          }) as Texture;

          return {
            texture,
            sampler: textureFactoryRef.current!.createSampler() as Sampler,
          };
        };

        const specularTexture = async () => {
          const response = await fetch('/sphere-specular.png');
          const blob = await response.blob();
          const imageBitmap = await createImageBitmap(blob);

          const texture = textureFactoryRef.current!.createTexture({
            dimensions: {
              width: imageBitmap.width,
              height: imageBitmap.height,
            },
            format: 'rgba8unorm',
            type: '2d',
            source: imageBitmap,
            label: 'specularTexture',
            readwrite: true,
          }) as Texture;

          return {
            texture,
            sampler: textureFactoryRef.current!.createSampler() as Sampler,
          };
        };

        const shininessTexture = async () => {
          const response = await fetch('/sphere-shininess.png');
          const blob = await response.blob();
          const imageBitmap = await createImageBitmap(blob);

          const texture = textureFactoryRef.current!.createTexture({
            dimensions: {
              width: imageBitmap.width,
              height: imageBitmap.height,
            },
            format: 'rgba8unorm',
            type: '2d',
            source: imageBitmap,
            label: 'shininessTexture',
            readwrite: true,
          }) as Texture;

          return {
            texture,
            sampler: textureFactoryRef.current!.createSampler() as Sampler,
          };
        };

        sceneAdapterRef.current!.scene.meshes[0].material.textures.push(
          await diffuseTexture(),
          await specularTexture(),
          await shininessTexture()
        );

        const depthTexture = applicationRef.current!.depthTexture;

        const meshRenderData = sceneAdapterRef.current!.setupMesh({
          mesh: sceneAdapterRef.current!.scene.meshes[0],
          device: applicationRef.current!.engine.device!,
        });

        const camera = sceneAdapterRef.current!.scene.cameras[0];

        let elapsedTime = 0;

        const renderLoop = () => {
          const deltaTime = 0.016; // Approximate 60 FPS
          elapsedTime += deltaTime;
          const offsetx = Math.sin(elapsedTime) * 5;
          const offsetZ = Math.cos(elapsedTime) * 5;
          camera.position = { x: offsetx, y: 0, z: offsetZ };
          const q = quat.fromAxisAngle(
            new Float32Array([0, 1, 0]),
            elapsedTime
          );
          camera.rotation = { x: q[0], y: q[1], z: q[2], w: q[3] };

          const commandEncoder =
            applicationRef.current!.engine.device!.createCommandEncoder();

          const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [applicationRef.current!.surface.colorAttachment],
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
          passEncoder.setViewport(
            0,
            0,
            applicationRef.current!.surface.width,
            applicationRef.current!.surface.height,
            0,
            1
          );
          sceneAdapterRef.current!.renderMesh({
            passEncoder,
            meshRenderData,
            device: applicationRef.current!.engine.device!,
            surface: applicationRef.current!.surface,
          });
          passEncoder.end();

          applicationRef.current!.engine.device!.queue.submit([
            commandEncoder.finish(),
          ]);
          requestAnimationFrame(renderLoop);
        };

        requestAnimationFrame(renderLoop);
      }}
    />
  );
}
