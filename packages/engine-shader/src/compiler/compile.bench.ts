import { bench, describe } from 'vitest';
import { defineFunction } from '../graph/functions';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';

// Time to compile a material graph, from validation to the IR.

const unlit = () => {
  const g = new GraphBuilder('unlit');
  const texel = g.call(std.textureSample, {
    texture: g.texture('map'),
    sampler: g.sampler('mapSampler'),
    uv: g.attribute('uv', BuiltinTypes.vec2f),
  });
  g.surface({ baseColor: texel.swizzle('rgb') });
  return g.build();
};

const lit = (shadingModel: 'phong' | 'pbr') => {
  const g = new GraphBuilder(shadingModel);
  g.surface({
    shadingModel,
    baseColor: g.uniform('color', BuiltinTypes.vec3f),
  });
  return g.build();
};

// Eight calls of a function calling a function: 16 inlined graphs.
const nested = () => {
  const inner = new GraphBuilder('inner');
  const x = inner.functionInput('x', BuiltinTypes.vec3f);
  inner.functionOutput(
    'result',
    inner.call(std.mul, { a: inner.call(std.sin, { x }), b: 0.5 })
  );
  const innerFunction = defineFunction(inner.build(), { id: 'bench.inner' });
  const outer = new GraphBuilder('outer');
  const y = outer.functionInput('y', BuiltinTypes.vec3f);
  outer.functionOutput(
    'result',
    outer.call(innerFunction, { x: outer.call(innerFunction, { x: y }) })
  );
  const outerFunction = defineFunction(outer.build(), {
    id: 'bench.outer',
    registry: outer.registry,
  });
  const g = new GraphBuilder('nested');
  let value = g.uniform('color', BuiltinTypes.vec3f);
  for (let i = 0; i < 8; i++) {
    value = g.call(outerFunction, { y: value });
  }
  g.surface({ baseColor: value });
  return g.build();
};

describe('compile', () => {
  const graphs = {
    unlit: unlit(),
    phong: lit('phong'),
    pbr: lit('pbr'),
    nested: nested(),
  };
  for (const [name, graph] of Object.entries(graphs)) {
    bench(name, () => {
      compile(graph);
    });
  }
});
