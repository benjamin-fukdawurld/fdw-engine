import { beforeAll, describe, expect, it } from 'vitest';
import { WebGl2BufferFactory } from '../gpu/WebGl2Buffer';
import { glslBlockName } from '../shader/GlslEsCodegen';
import { fakeGl, installGl } from '../testing/fakeGl';
import { testPipeline, testProgram } from '../testing/programs';
import {
  WebGl2CommandBuffer,
  WebGl2CommandEncoder,
} from './WebGl2CommandEncoder';
import { WebGl2PipelineFactory } from './WebGl2PipelineFactory';
import { WebGl2RenderTarget } from './WebGl2RenderTarget';

beforeAll(installGl);

function setup() {
  const fake = fakeGl({ uniformBlocks: [glslBlockName('material')] });
  const { gl } = fake;
  const pipelines = new WebGl2PipelineFactory(gl);
  const buffers = new WebGl2BufferFactory(gl);
  const color = new WebGl2RenderTarget(gl, 64, 100, 'rgba8unorm');
  const depth = new WebGl2RenderTarget(gl, 64, 100, 'depth24plus');
  const positions = buffers.create({ size: 48, usage: ['vertex'] });
  const indices = buffers.create({ size: 6, usage: ['index'] });
  // Runs the commands recorded, from a clean record of the calls.
  const run = (encoder: WebGl2CommandEncoder) => {
    const commands = encoder.finish() as WebGl2CommandBuffer;
    fake.calls.length = 0;
    commands.execute(gl);
  };
  return { ...fake, pipelines, buffers, color, depth, positions, indices, run };
}

describe('WebGl2CommandEncoder', () => {
  it('records the draws, run on submit', () => {
    const {
      pipelines,
      color,
      depth,
      positions,
      indices,
      run,
      named,
      calls,
      C,
    } = setup();
    const pipeline = pipelines.createRenderPipeline(testPipeline());
    const encoder = new WebGl2CommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          target: color,
          load: 'clear',
          clearValue: { r: 1, g: 0.5, b: 0, a: 1 },
        },
      ],
      depthAttachment: { target: depth, load: 'clear' },
    });
    pass.setPipeline(pipeline);
    // OpenGL counts rows from the bottom.
    pass.setViewport(0, 10, 32, 20);
    pass.setVertexBuffer(0, positions);
    pass.setIndexBuffer(indices, 'uint16');
    pass.drawIndexed(3, 2);
    pass.end();
    calls.length = 0;
    // Nothing runs while recording.
    expect(calls).toEqual([]);

    run(encoder);
    expect(named('clearBufferfv')).toEqual([[C.COLOR, 0, [1, 0.5, 0, 1]]]);
    // The depth mask also applies to clears.
    expect(named('depthMask')[0]).toEqual([true]);
    expect(named('clear')).toEqual([[C.DEPTH_BUFFER_BIT]]);
    expect(named('viewport')).toEqual([
      [0, 0, 64, 100],
      [0, 70, 32, 20],
    ]);
    expect(named('enable')).toEqual(
      expect.arrayContaining([[C.CULL_FACE], [C.DEPTH_TEST]]),
    );
    expect(named('cullFace')).toEqual([[C.BACK]]);
    // The positions: the second buffer of the mesh, the first of the
    // pipeline.
    expect(named('vertexAttribPointer')).toEqual([
      [0, 3, C.FLOAT, false, 16, 4],
    ]);
    expect(named('vertexAttribDivisor')).toEqual([[0, 0]]);
    expect(named('bindBuffer')).toEqual(
      expect.arrayContaining([
        [C.ARRAY_BUFFER, positions.buffer],
        [C.ELEMENT_ARRAY_BUFFER, indices.buffer],
      ]),
    );
    expect(named('drawElementsInstanced')).toEqual([
      [C.TRIANGLES, 3, C.UNSIGNED_SHORT, 0, 2],
    ]);
    // The vertex array of the pipeline is unbound at the end of the pass.
    expect(named('bindVertexArray').at(-1)).toEqual([null]);
  });

  it('captures the state of each draw', () => {
    const { pipelines, color, buffers, run, named } = setup();
    const pipeline = pipelines.createRenderPipeline(testPipeline());
    const [first, second] = [0, 1].map(() =>
      buffers.create({ size: 48, usage: ['vertex'] }),
    );
    const encoder = new WebGl2CommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ target: color, load: 'load' }],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, first);
    pass.draw(3);
    pass.setVertexBuffer(0, second);
    pass.draw(6, 1);
    pass.end();
    run(encoder);
    expect(named('clearBufferfv')).toEqual([]);
    expect(
      named('bindBuffer')
        .filter((call) => call[1] === first.buffer || call[1] === second.buffer)
        .map((call) => call[1]),
    ).toEqual([first.buffer, second.buffer]);
    expect(named('drawArraysInstanced').map((call) => call[2])).toEqual([3, 6]);
  });

  it('refuses incomplete draws', () => {
    const { pipelines, color, run } = setup();
    const encoder = new WebGl2CommandEncoder();
    expect(() => encoder.beginRenderPass({ colorAttachments: [] })).toThrow(
      /needs a color or a depth attachment/,
    );
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ target: color, load: 'load' }],
    });
    expect(() => pass.draw(3)).toThrow(/No pipeline set/);
    pass.setPipeline(pipelines.createRenderPipeline(testPipeline()));
    expect(() => pass.drawIndexed(3)).toThrow(/needs an index buffer/);
    expect(() =>
      pass.setPipeline({ vertexBuffers: [], destroy: () => undefined }),
    ).toThrow(/The pipeline was not created by the WebGL2 backend/);
    // The vertex buffers are checked when the draw runs.
    pass.draw(3);
    pass.end();
    expect(() => run(encoder)).toThrow(/No vertex buffer set in slot 0/);
  });

  it('binds the uniform blocks of the program', () => {
    const { pipelines, buffers, color, positions, run, named, C } = setup();
    const program = testProgram('uniforms', { uniforms: true });
    const pipeline = pipelines.createRenderPipeline(testPipeline(program));
    const group = pipelines
      .resolveLayout(program)
      .groups.find((candidate) => candidate.slot === 'material')!;
    const uniforms = buffers.create({ size: 16, usage: ['uniform'] });

    const record = (bound: boolean) => {
      const encoder = new WebGl2CommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ target: color, load: 'load' }],
      });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, positions);
      if (bound) {
        pass.setBindGroup(
          group.index,
          pipelines.createBindGroup(pipelines.createBindGroupLayout(group), [
            { binding: group.bindings[0].binding, resource: uniforms },
          ]),
        );
      }
      pass.draw(3);
      pass.end();
      return encoder;
    };
    expect(() => run(record(false))).toThrow(
      new RegExp(`No resource bound at group ${group.index}`),
    );
    run(record(true));
    expect(named('bindBufferBase')).toEqual([
      [C.UNIFORM_BUFFER, 0, uniforms.buffer],
    ]);
  });

  it('copies buffers, on the GPU', () => {
    const { buffers, run, bytes } = setup();
    const from = buffers.create({
      size: 8,
      usage: ['copy-src'],
      initialData: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const to = buffers.create({ size: 8, usage: ['copy-dst'] });
    const encoder = new WebGl2CommandEncoder();
    encoder.copyBufferToBuffer(from, 4, to, 0, 4);
    expect([...bytes(to.buffer)!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    run(encoder);
    expect([...bytes(to.buffer)!]).toEqual([5, 6, 7, 8, 0, 0, 0, 0]);
    expect(() =>
      encoder.copyBufferToBuffer(
        { size: 4, usage: [], write: () => undefined } as never,
        0,
        to,
        0,
        4,
      ),
    ).toThrow(/The source buffer was not created by the WebGL2 backend/);
  });
});
