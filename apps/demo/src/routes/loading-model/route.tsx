import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { Engine, Surface } from '@fdw/engine-backend';
import { instantiate, ModelType, type Model } from '@fdw/engine-assets';
import { Camera, PointLight, Renderer } from '@fdw/engine-core';
import type { ResourceScope } from '@fdw/engine-resources';
import { Scene } from '@fdw/engine-scene';
import Layout from '../../components/Layout';
import { axisAngle, demoResources } from '../../utils3d';

export const Route = createFileRoute('/loading-model')({
  component: RouteComponent,
});

function RouteComponent() {
  const frameRef = useRef<number | undefined>(undefined);
  const rendererRef = useRef<Renderer | undefined>(undefined);
  const scopeRef = useRef<ResourceScope | undefined>(undefined);

  // Stop rendering and release the model when leaving the route.
  useEffect(
    () => () => {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
      rendererRef.current?.destroy();
      scopeRef.current?.dispose();
    },
    [],
  );

  const onSurfaceReady = async (engine: Engine, surface: Surface) => {
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    const renderer = new Renderer(backend);
    rendererRef.current = renderer;

    // The sphere and its MTL file, whose maps (diffuse, specular,
    // shininess) are loaded as dependencies.
    const resources = demoResources(backend);
    const scope = resources.scope('loading-model');
    scopeRef.current = scope;
    const sphere = scope.load<Model>(ModelType, 'sphere.obj');
    const scene = new Scene();
    instantiate(await sphere.ready, scene);

    // The light of the former scene: a white point light, without
    // attenuation, placed by its node.
    scene.root.add({ position: { x: -10, y: 10, z: 10 } }).setLight(
      new PointLight({
        ambient: { x: 0.1, y: 0.1, z: 0.1 },
        diffuse: { x: 1, y: 1, z: 1 },
        specular: { x: 1, y: 1, z: 1 },
      }),
    );

    const camera = new Camera({
      projection: {
        type: 'perspective',
        fov: 45,
        aspect: surface.width / surface.height,
        near: 0.1,
        far: 100,
      },
    });

    // The camera orbits around the model, looking at it.
    const start = performance.now();
    const frame = () => {
      const time = (performance.now() - start) / 1000;
      camera.position = { x: Math.sin(time) * 5, y: 0, z: Math.cos(time) * 5 };
      camera.rotation = axisAngle(0, 1, 0, time);
      resources.update();
      renderer.render({
        source: scene,
        camera,
        surface,
        time,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
      });
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
  };

  return <Layout onSurfaceReady={onSurfaceReady} portable />;
}
