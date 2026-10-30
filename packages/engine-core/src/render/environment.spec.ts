import { BuiltinTypes, defineFunction, GraphBuilder } from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { Transform } from '../Transform';
import { fakeBackend, surface, triangle } from '../testing/fakeBackend';
import {
  Environment,
  environmentAtlasSize,
  environmentTile,
} from './environment';
import { Material } from './Material';
import { Renderer } from './Renderer';

// A sky of a function: brighter up.
const skyFunction = () => {
  const f = new GraphBuilder('gradient');
  const direction = f.functionInput('direction', BuiltinTypes.vec3f);
  f.functionOutput('color', direction);
  return defineFunction(f.build(), { id: 'test.gradient' });
};

const lit = () => {
  const g = new GraphBuilder('lit');
  g.surface({ shadingModel: 'pbr', baseColor: [1, 1, 1], normal: [0, 0, 1] });
  return new Material({ graph: g.build() });
};

describe('Environment', () => {
  it('lays its atlas out in 4 × 2 tiles with a border of one texel', () => {
    expect(environmentAtlasSize(16)).toEqual({ width: 72, height: 36 });
    expect(environmentTile(0, 16)).toEqual({
      x: 0,
      y: 0,
      width: 18,
      height: 18,
    });
    expect(environmentTile(5, 16)).toEqual({
      x: 18,
      y: 18,
      width: 18,
      height: 18,
    });
  });

  it('is prefiltered on its first frame and after an update only', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const environment = new Environment(
      { sky: skyFunction() },
      { size: 16, intensity: 2 },
    );
    const frame = () => {
      log.renderPasses.length = 0;
      log.viewports.length = 0;
      renderer.render({
        items: [
          { mesh: triangle(), material: lit(), transform: new Transform() },
        ],
        camera: new Camera(),
        surface,
        environment,
      });
      return [...log.renderPasses];
    };
    const prefilter = [
      'environment 0 capture',
      ...Array.from({ length: 8 }, (_, tile) => `environment 0 tile ${tile}`),
    ];
    expect(frame()).toEqual([...prefilter, 'scene opaque']);
    // Each tile in its rectangle of the atlas.
    expect(log.viewports).toEqual(
      Array.from({ length: 8 }, (_, tile) => {
        const { x, y, width, height } = environmentTile(tile, 16);
        return [x, y, width, height];
      }),
    );
    expect(frame()).toEqual(['scene opaque']);
    environment.update();
    expect(frame()).toEqual([...prefilter, 'scene opaque']);
    // The programs of the scene reflect it.
    expect(
      log.pipelines.some(
        (pipeline) => pipeline.program.variantKey['environment'] === true,
      ),
    ).toBe(true);
  });
});
