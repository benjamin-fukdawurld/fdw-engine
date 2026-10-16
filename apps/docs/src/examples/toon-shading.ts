import {
  Camera,
  DirectionalLight,
  Material,
  PointLight,
  Renderer,
  Transform,
} from '@fdw/engine-core';
import {
  BuiltinTypes,
  createStandardRegistry,
  defineShadingModel,
  GraphBuilder,
  std,
  stdLights,
} from '@fdw/engine-shader';
import { createSphere } from '@fdw/demo-scenes';
import type { Example } from './runtime';

// A custom shading model: toon shading, in a few flat bands of light.
const example: Example = ({ backend, surface, onFrame }) => {
  const registry = createStandardRegistry();

  // The model is a function graph: the inputs of the surface, plus the
  // world position, and a color output.
  const f = new GraphBuilder('toon', registry);
  const baseColor = f.functionInput('baseColor', BuiltinTypes.vec3f, {
    default: [1, 1, 1],
  });
  const bands = f.functionInput('bands', BuiltinTypes.f32, { default: 3 });
  const normal = f.functionInput('normal', BuiltinTypes.vec3f);
  const position = f.functionInput('worldPosition', BuiltinTypes.vec4f);

  // For each light: the direction to it (w = 0 for a directional light),
  // and the diffuse light it gives, weighted by its intensity. light.sum
  // adds them up.
  const light = f.node(stdLights.current);
  const toLight = f.call(std.normalize, {
    x: f.call(std.sub, {
      a: light.position.swizzle('xyz'),
      b: f.call(std.mul, {
        a: position.swizzle('xyz'),
        b: light.position.swizzle('w'),
      }),
    }),
  });
  const intensity = f.call(std.dot, {
    a: light.diffuse,
    b: [1 / 3, 1 / 3, 1 / 3],
  });
  const received = f.call(stdLights.sum, {
    value: f.call(std.mul, {
      a: f.call(std.max, {
        a: f.call(std.dot, {
          a: f.call(std.normalize, { x: normal }),
          b: toLight,
        }),
        b: 0,
      }),
      b: intensity,
    }),
  });

  // The light, rounded down to a few levels.
  const level = f.call(std.div, {
    a: f.call(std.floor, {
      x: f.call(std.mul, {
        a: f.call(std.saturate, { x: received }),
        b: bands,
      }),
    }),
    b: bands,
  });
  f.functionOutput(
    'color',
    f.call(std.extend, {
      xyz: f.call(std.mul, {
        a: baseColor,
        b: f.call(std.mix, { a: 0.25, b: 1, t: level }),
      }),
      w: 1,
    }),
  );
  registry.register(defineShadingModel('toon', f.build()));

  // A material using it: its inputs are those of the model.
  const g = new GraphBuilder('cartoon', registry);
  g.surface({
    shadingModel: 'toon',
    baseColor: g.uniform('color', BuiltinTypes.vec3f, {
      default: [0.9, 0.3, 0.2],
    }),
    bands: g.uniform('bands', BuiltinTypes.f32, { default: 3 }),
  });
  const graph = g.build();

  const sphere = createSphere(64, 32);
  const items = [
    { color: [0.9, 0.3, 0.2], bands: 2, x: -1.2 },
    { color: [0.3, 0.7, 0.3], bands: 3, x: 0 },
    { color: [0.2, 0.4, 0.9], bands: 5, x: 1.2 },
  ].map(({ color, bands, x }) => ({
    mesh: sphere,
    material: new Material({ graph, values: { color, bands } }),
    transform: new Transform({ position: { x, y: 0, z: 0 } }),
  }));

  // Two dim lights: their sum stays below 1, across the bands.
  const sun = new DirectionalLight({
    direction: { x: -1, y: -0.5, z: -1 },
    diffuse: { x: 0.6, y: 0.6, z: 0.6 },
  });
  const lamp = new PointLight({
    position: { x: 0, y: 0, z: 2 },
    diffuse: { x: 0.5, y: 0.5, z: 0.5 },
    quadraticAttenuation: 0.3,
  });
  const camera = new Camera({
    position: { x: 0, y: 0, z: 4 },
    projection: {
      type: 'perspective',
      fov: 45,
      aspect: 16 / 9,
      near: 0.1,
      far: 100,
    },
  });
  const renderer = new Renderer(backend, { registry });

  onFrame((time) => {
    lamp.position = { x: 2 * Math.cos(time), y: Math.sin(time), z: 2 };
    renderer.render({
      items,
      camera,
      surface,
      lights: [sun, lamp],
      clearColor: { r: 0.95, g: 0.93, b: 0.88, a: 1 },
    });
  });
};

export default example;
