import { alphaBlending } from '@fdw/engine-backend';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeGl, FakeGlOptions, installGl } from '../testing/fakeGl';
import { testPipeline, testProgram } from '../testing/programs';
import {
  WebGl2PipelineFactory,
  WebGl2RenderPipeline,
} from './WebGl2PipelineFactory';

beforeAll(installGl);

function setup(options?: FakeGlOptions) {
  const fake = fakeGl(options);
  return { ...fake, factory: new WebGl2PipelineFactory(fake.gl) };
}

describe('WebGl2PipelineFactory', () => {
  it('links a program per key, its shaders freed with it', () => {
    const { factory, alive, named } = setup();
    const first = factory.createRenderPipeline(testPipeline());
    const second = factory.createRenderPipeline(testPipeline());
    expect(named('linkProgram')).toHaveLength(1);
    expect(alive('program')).toHaveLength(1);
    // Flagged for deletion: freed by the driver with the program.
    expect(alive('shader')).toEqual([]);
    // A vertex array per pipeline.
    expect(alive('vertex array')).toHaveLength(2);
    expect(first).toBeInstanceOf(WebGl2RenderPipeline);
    expect((first as WebGl2RenderPipeline).program).toBe(
      (second as WebGl2RenderPipeline).program,
    );
  });

  it('keeps the vertex buffers read by the program', () => {
    const { factory, C } = setup();
    const pipeline = factory.createRenderPipeline(
      testPipeline(testProgram(), {
        primitive: {
          topology: 'line-strip',
          cullMode: 'none',
          frontFace: 'cw',
        },
        depthStencil: {
          format: 'depth32float',
          depthWrite: false,
          depthCompare: 'greater',
          depthBias: 2,
          depthBiasSlopeScale: 1.5,
        },
        targets: [{ format: 'rgba8unorm', blend: alphaBlending }],
      }),
    ) as WebGl2RenderPipeline;
    // The normals are not read: only the buffer of the positions.
    expect(pipeline.vertexBuffers).toEqual([1]);
    expect(pipeline.buffers[0].attributes).toEqual([
      { format: 'float32x3', offset: 4, location: 0 },
    ]);
    expect(pipeline.topology).toBe(C.LINE_STRIP);
    expect(pipeline.cullFace).toBeUndefined();
    expect(pipeline.frontFace).toBe(C.CW);
    expect(pipeline.depth).toEqual({
      write: false,
      compare: C.GREATER,
      bias: { slope: 1.5, constant: 2 },
    });
    expect(pipeline.blend?.color).toEqual([
      C.SRC_ALPHA,
      C.ONE_MINUS_SRC_ALPHA,
      C.FUNC_ADD,
    ]);
  });

  it('refuses targets blended differently, without leaking', () => {
    const { factory, alive } = setup();
    expect(() =>
      factory.createRenderPipeline(
        testPipeline(testProgram(), {
          targets: [
            { format: 'rgba8unorm', blend: alphaBlending },
            { format: 'rgba8unorm' },
            // Integer targets are never blended.
            { format: 'r32uint' },
          ],
        }),
      ),
    ).toThrow(/independentBlend/);
    expect(alive('vertex array')).toEqual([]);
  });

  it('deletes the program and the shaders of a failed link', () => {
    let status = false;
    const { factory, alive } = setup({ linkStatus: () => status });
    expect(() => factory.createRenderPipeline(testPipeline())).toThrow(
      /Program "program test" failed to link:\nprogram log/,
    );
    expect(alive('program')).toEqual([]);
    expect(alive('shader')).toEqual([]);
    // Linked again.
    status = true;
    factory.createRenderPipeline(testPipeline());
    expect(alive('program')).toHaveLength(1);
  });

  it('deletes a program linked twice for the same key', async () => {
    const { factory, alive, named } = setup();
    // The asynchronous link finishes after the synchronous one.
    const pending = factory.createRenderPipelineAsync(testPipeline());
    const linked = factory.createRenderPipeline(testPipeline());
    const pipeline = await pending;
    expect(named('linkProgram')).toHaveLength(2);
    expect(alive('program')).toHaveLength(1);
    expect(alive('shader')).toEqual([]);
    expect((pipeline as WebGl2RenderPipeline).program).toBe(
      (linked as WebGl2RenderPipeline).program,
    );
  });

  it('deletes the vertex array of a pipeline, and the program with the last one', async () => {
    const { factory, alive, named } = setup();
    const first = factory.createRenderPipeline(testPipeline());
    const second = await factory.createRenderPipelineAsync(testPipeline());
    const other = factory.createRenderPipeline(testPipeline(testProgram('b')));
    expect(alive('program')).toHaveLength(2);

    first.destroy();
    first.destroy();
    expect(alive('vertex array')).toHaveLength(2);
    expect(alive('program')).toHaveLength(2);
    second.destroy();
    expect(alive('vertex array')).toHaveLength(1);
    expect(alive('program')).toHaveLength(1);

    // Linked again for the next pipeline, synchronous or not.
    const again = await factory.createRenderPipelineAsync(testPipeline());
    expect(named('linkProgram')).toHaveLength(3);
    again.destroy();
    other.destroy();
    expect(alive('program')).toEqual([]);
    expect(alive('vertex array')).toEqual([]);
  });
});
