import {
  Camera,
  DirectionalLight,
  Material,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import { axisAngle, createCube, createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A textured material: a checker texture, repeated, tinted by a uniform.
const example: Example = ({ backend, surface, onFrame }) => {
  const g = new GraphBuilder('checker');
  const uv = g.call(std.mul, {
    a: g.attribute('uv', BuiltinTypes.vec2f),
    b: g.uniform('tiling', BuiltinTypes.f32, { default: 4 }),
  });
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv,
  });
  g.surface({
    shadingModel: 'phong',
    baseColor: g.call(std.mul, {
      a: texel.swizzle('rgb'),
      b: g.uniform('tint', BuiltinTypes.vec3f, { default: [1, 1, 1] }),
    }),
    shininess: 32,
  });
  const graph = g.build();

  // An 8 × 8 checker, in an sRGB format: decoded to linear colors by the GPU.
  const size = 8;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = (x + y) % 2 === 0 ? 255 : 60;
      pixels.set([value, value, value, 255], (y * size + x) * 4);
    }
  }
  const map = backend.textures.createTexture({
    type: '2d',
    format: 'rgba8unorm-srgb',
    dimensions: { width: size, height: size },
    source: pixels,
  });
  const mapSampler = backend.textures.createSampler({
    wrapModeS: 'repeat',
    wrapModeT: 'repeat',
    minFilter: 'nearest',
    magFilter: 'nearest',
  });

  // Two materials of the same graph: one program, two sets of values.
  const ballMaterial = new Material({ graph, values: { map, mapSampler } });
  const boxMaterial = new Material({
    graph,
    values: { map, mapSampler, tiling: 2, tint: [1, 0.6, 0.2] },
  });

  const ball = new Transform({ position: { x: -0.8, y: 0, z: 0 } });
  const box = new Transform({ position: { x: 0.8, y: 0, z: 0 } });
  const sphere = createSphere(48, 24);
  const cube = createCube();
  const camera = new Camera({
    position: { x: 0, y: 0, z: 3.2 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const sun = new DirectionalLight({ direction: { x: -1, y: -1, z: -1 } });
  const renderer = new Renderer(backend);

  onFrame((time) => {
    ball.rotation = axisAngle(0, 1, 0, time * 0.5);
    // Around a unit axis: a unit quaternion.
    box.rotation = axisAngle(Math.SQRT1_2, Math.SQRT1_2, 0, time * 0.5);
    // A new value is a buffer write: nothing is recompiled.
    const hue = 0.5 + 0.5 * Math.sin(time);
    ballMaterial.setValue('tint', [1, hue, 1 - hue]);
    renderer.render({
      items: [
        { mesh: sphere, material: ballMaterial, transform: ball },
        { mesh: cube, material: boxMaterial, transform: box },
      ],
      camera,
      surface,
      lights: [sun],
      clearColor: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
    });
  });
};

export default example;
