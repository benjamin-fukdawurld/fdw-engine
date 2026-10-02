import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { Engine, RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Camera,
  Material,
  PointLight,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { GraphBuilder, std, T } from '@fdw/engine-shader';
import Layout from '../../components/Layout';
import { ObjImporter } from '../../utils3d';
import { axisAngle, meshFromObj } from '../../utils3d/geometry';

export const Route = createFileRoute('/loading-model')({
  component: RouteComponent,
});

// Phong with diffuse, specular and shininess maps, as the former Eta
// templates: the shininess map stores the exponent divided by 255.
function texturedPhong() {
  const g = new GraphBuilder('textured-phong');
  const uv = g.attribute('uv', T.vec2f);
  const sample = (name: string) =>
    g.call(std.textureSample, {
      texture: g.texture(`${name}Map`),
      sampler: g.sampler(`${name}Sampler`),
      uv,
    });
  g.surface({
    shadingModel: 'phong',
    baseColor: sample('diffuse').swizzle('rgb'),
    specular: sample('specular').swizzle('rgb'),
    shininess: g.call(std.mul, { a: sample('shininess').swizzle('r'), b: 255 }),
  });
  return g.build();
}

async function loadTexture(backend: RenderBackend, url: string) {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  return backend.textures.createTexture({
    label: url,
    type: '2d',
    format: 'rgba8unorm',
    dimensions: { width: image.width, height: image.height },
    source: image,
  });
}

function RouteComponent() {
  const frameRef = useRef<number | undefined>(undefined);
  const rendererRef = useRef<Renderer | undefined>(undefined);

  // Stop rendering when leaving the route.
  useEffect(
    () => () => {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
      rendererRef.current?.destroy();
    },
    []
  );

  const onSurfaceReady = async (engine: Engine, surface: Surface) => {
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    const renderer = new Renderer(backend);
    rendererRef.current = renderer;

    const [model] = await ObjImporter.load('/sphere.obj');
    const sampler = backend.textures.createSampler();
    const material = new Material({
      graph: texturedPhong(),
      values: {
        diffuseMap: await loadTexture(backend, '/sphere-diffuse.png'),
        specularMap: await loadTexture(backend, '/sphere-specular.png'),
        shininessMap: await loadTexture(backend, '/sphere-shininess.png'),
        diffuseSampler: sampler,
        specularSampler: sampler,
        shininessSampler: sampler,
      },
    });
    const items = [
      {
        mesh: meshFromObj(model, 'sphere'),
        material,
        transform: new Transform(),
      },
    ];

    // The light of the former scene: a white point light, without attenuation.
    const light = new PointLight({
      position: { x: -10, y: 10, z: 10 },
      ambient: { x: 0.1, y: 0.1, z: 0.1 },
      diffuse: { x: 1, y: 1, z: 1 },
      specular: { x: 1, y: 1, z: 1 },
    });

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
      renderer.render({
        items,
        camera,
        surface,
        time,
        lights: [light],
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
      });
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
  };

  return <Layout onSurfaceReady={onSurfaceReady} />;
}
