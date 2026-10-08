import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { Engine, RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  SpotLight,
  Renderer,
  RenderItem,
  Transform,
} from '@fdw/engine-core';
import { GraphBuilder, std, BuiltinTypes } from '@fdw/engine-shader';
import Layout from '../../components/Layout';
import { axisAngle, createCube } from '../../utils3d/geometry';

export const Route = createFileRoute('/material-graph')({
  component: RouteComponent,
});

// Phong, textured, multiplied by a tint.
function texturedGraph() {
  const g = new GraphBuilder('textured');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  const tint = g.uniform('tint', BuiltinTypes.vec3f, { default: [1, 1, 1] });
  g.surface({
    shadingModel: 'phong',
    baseColor: g.call(std.mul, { a: texel.swizzle('rgb'), b: tint }),
    specular: [0.3, 0.3, 0.3],
    shininess: 16,
  });
  return g.build();
}

// Unlit: a color cycling between two uniforms, driven by the engine time.
function pulsingGraph() {
  const g = new GraphBuilder('pulsing');
  const wave = g.call(std.sin, {
    x: g.call(std.mul, { a: g.engine('time'), b: 2 }),
  });
  const t = g.call(std.add, {
    a: g.call(std.mul, { a: wave, b: 0.5 }),
    b: 0.5,
  });
  g.surface({
    baseColor: g.call(std.mix, {
      a: g.uniform('from', BuiltinTypes.vec3f, { default: [1, 0.3, 0.1] }),
      b: g.uniform('to', BuiltinTypes.vec3f, { default: [0.1, 0.4, 1] }),
      t,
    }),
  });
  return g.build();
}

// Phong with an alpha, drawn with blending: a shiny glass.
function glassGraph() {
  const g = new GraphBuilder('glass');
  const color = g.uniform('color', BuiltinTypes.vec4f, {
    default: [0.6, 1, 0.8, 0.4],
  });
  g.surface({
    shadingModel: 'phong',
    baseColor: color.swizzle('rgb'),
    alpha: color.swizzle('a'),
    shininess: 64,
  });
  return g.build();
}

// Color textures are sRGB, decoded to linear colors by the GPU; data
// textures (specular, shininess…) are linear.
async function loadTexture(
  backend: RenderBackend,
  url: string,
  colorSpace: 'srgb' | 'linear' = 'srgb'
) {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  return backend.textures.createTexture({
    label: url,
    type: '2d',
    format: colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm',
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

    const cube = createCube();
    const textured = new Material({
      graph: texturedGraph(),
      values: {
        map: await loadTexture(backend, '/cube.png'),
        mapSampler: backend.textures.createSampler(),
      },
    });
    const pulsing = new Material({ graph: pulsingGraph() });
    const glass = new Material({
      graph: glassGraph(),
      renderState: { alphaMode: 'blend', doubleSided: true },
    });

    const transforms = [-1.6, 0, 1.6].map(
      (x) => new Transform({ position: { x, y: 0, z: 0 } })
    );
    const items: RenderItem[] = [
      { mesh: cube, material: textured, transform: transforms[0] },
      { mesh: cube, material: pulsing, transform: transforms[1] },
      { mesh: cube, material: glass, transform: transforms[2] },
    ];

    // Summed by the Phong materials: a white key light above the camera, a
    // cold rim light from behind on the left, and a warm spot circling the
    // cubes.
    const keyLight = new PointLight({
      position: { x: 3, y: 4, z: 6 },
      ambient: { x: 0.1, y: 0.1, z: 0.1 },
      diffuse: { x: 0.8, y: 0.8, z: 0.8 },
      specular: { x: 0.8, y: 0.8, z: 0.8 },
    });
    const rimLight = new DirectionalLight({
      direction: { x: 1, y: -0.3, z: 0.6 },
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: { x: 0.2, y: 0.35, z: 0.8 },
      specular: { x: 0.2, y: 0.35, z: 0.8 },
    });
    const spot = new SpotLight({
      position: { x: 0, y: 3, z: 3 },
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: { x: 1, y: 0.6, z: 0.2 },
      specular: { x: 1, y: 0.6, z: 0.2 },
      innerCutoff: 8,
      outerCutoff: 16,
    });
    const lights = [keyLight, rimLight, spot];

    const camera = new Camera({
      position: { x: 0, y: 0, z: 5 },
      projection: {
        type: 'perspective',
        fov: 45,
        aspect: surface.width / surface.height,
        near: 0.1,
        far: 100,
      },
    });

    const start = performance.now();
    const frame = () => {
      const time = (performance.now() - start) / 1000;
      transforms.forEach((transform, i) => {
        transform.rotation = axisAngle(0.6, 0.8, 0, time * (0.5 + i * 0.25));
      });
      // The tint is a uniform: changing it does not recompile anything.
      textured.setValue('tint', [1, 0.75 + 0.25 * Math.sin(time), 1]);
      // The spot sweeps the three cubes.
      const target = { x: 1.6 * Math.sin(time * 0.8), y: 0, z: 0 };
      spot.direction = {
        x: target.x - spot.position.x,
        y: target.y - spot.position.y,
        z: target.z - spot.position.z,
      };

      renderer.render({
        items,
        camera,
        surface,
        time,
        lights,
        clearColor: { r: 0.08, g: 0.08, b: 0.1, a: 1 },
      });
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
  };

  return <Layout onSurfaceReady={onSurfaceReady} portable />;
}
