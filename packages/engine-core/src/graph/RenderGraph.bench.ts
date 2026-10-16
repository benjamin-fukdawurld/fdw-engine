import { bench, describe } from 'vitest';
import { fakeBackend, surface } from '../testing/fakeBackend';
import { RenderGraph } from './RenderGraph';
import { RenderGraphRunner } from './RenderGraphRunner';

// CPU cost of the render graph per frame, without GPU: declaring a graph,
// compiling it (or finding its compilation), allocating its resources and
// recording its passes, which draw nothing.

// A frame of a deferred-like technique: `passes` passes in a chain, each
// reading the previous texture and writing its own, then a present pass.
const frame = (passes: number) => {
  const graph = new RenderGraph();
  const backbuffer = graph.importTexture('backbuffer', surface);
  let previous = graph.addRasterPass('pass 0', (pass) => ({
    color: pass.writeColor(
      graph.createTexture('texture 0', { format: 'rgba16float' }),
      { load: 'clear' },
    ),
    execute: () => undefined,
  })).color;
  for (let i = 1; i < passes; i++) {
    const source = previous;
    previous = graph.addRasterPass(`pass ${i}`, (pass) => {
      pass.read(source, 'sampled');
      return {
        color: pass.writeColor(
          graph.createTexture(`texture ${i}`, { format: 'rgba16float' }),
          { load: 'clear' },
        ),
        execute: () => undefined,
      };
    }).color;
  }
  const last = previous;
  graph.addRasterPass('present', (pass) => {
    pass.read(last, 'sampled');
    return {
      color: pass.writeColor(backbuffer, { load: 'clear' }),
      execute: () => undefined,
    };
  });
  return graph;
};

describe('RenderGraph', () => {
  for (const passes of [3, 10, 50]) {
    bench(`declare and compile, ${passes} passes`, () => {
      frame(passes).compile();
    });
  }
});

describe('RenderGraphRunner.execute', () => {
  for (const passes of [3, 10, 50]) {
    const runner = new RenderGraphRunner(fakeBackend().backend);
    runner.execute(frame(passes));
    // Cached compilation, pooled resources: the cost of every frame.
    bench(`declare and execute, ${passes} passes`, () => {
      runner.execute(frame(passes));
    });
  }
});
