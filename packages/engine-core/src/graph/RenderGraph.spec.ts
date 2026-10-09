import type {
  GpuBuffer,
  GpuTexture,
  RenderBackend,
  RenderPassDescriptor,
  ResourceTransition,
} from '@fdw/engine-backend';
import { describe, expect, it } from 'vitest';
import { RenderGraph } from './RenderGraph';
import { RenderGraphRunner } from './RenderGraphRunner';

// A backend recording what the runner creates and records.
function fakeBackend(options: { explicitTransitions?: boolean } = {}) {
  const log = {
    textures: [] as (GpuTexture & { usage?: readonly string[] })[],
    buffers: [] as (GpuBuffer & { usage: readonly string[] })[],
    events: [] as string[],
    renderPasses: [] as RenderPassDescriptor[],
    transitions: [] as ResourceTransition[][],
    destroyed: [] as string[],
  };
  const backend = {
    textures: {
      createTexture: (descriptor: GpuTexture & { usage?: string[] }) => {
        const texture = {
          ...descriptor,
          destroy: () => log.destroyed.push(descriptor.label ?? ''),
        };
        log.textures.push(texture);
        return texture;
      },
    },
    buffers: {
      create: (descriptor: {
        size: number;
        usage: string[];
        label?: string;
      }) => {
        const buffer = {
          ...descriptor,
          write: () => undefined,
          read: async () => new ArrayBuffer(0),
          destroy: () => log.destroyed.push(descriptor.label ?? ''),
        };
        log.buffers.push(buffer as never);
        return buffer;
      },
    },
    createCommandEncoder: () => ({
      beginRenderPass: (descriptor: RenderPassDescriptor) => {
        log.events.push(`render ${descriptor.label}`);
        log.renderPasses.push(descriptor);
        return { end: () => log.events.push('end') };
      },
      beginComputePass: (label: string) => {
        log.events.push(`compute ${label}`);
        return { end: () => log.events.push('end') };
      },
      copyBufferToBuffer: () => undefined,
      copyTextureToTexture: () => undefined,
      ...(options.explicitTransitions
        ? {
            transition: (transitions: ResourceTransition[]) =>
              log.transitions.push(transitions),
          }
        : {}),
      finish: () => ({}),
    }),
    submit: () => log.events.push('submit'),
  } as unknown as RenderBackend;
  return { backend, log };
}

const surface = { width: 64, height: 32, format: 'rgba8unorm' };

// Records the name of the pass when it runs.
const run = (log: { events: string[] }, name: string) => (): void => {
  log.events.push(`run ${name}`);
};

describe('RenderGraph', () => {
  it('culls the passes whose results are not used', () => {
    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer', surface);
    const unused = graph.createTexture('unused', { format: 'rgba8unorm' });
    graph.addRasterPass('unused', (pass) => ({
      color: pass.writeColor(unused, { load: 'clear' }),
      execute: () => undefined,
    }));
    graph.addRasterPass('final', (pass) => ({
      color: pass.writeColor(backbuffer, { load: 'clear' }),
      execute: () => undefined,
    }));
    const compiled = graph.compile();
    expect(compiled.order).toEqual([1]);
    expect(compiled.culled).toEqual(['unused']);
  });

  it('keeps the writer of a loaded version, not of a cleared one', () => {
    const build = (load: 'clear' | 'load') => {
      const graph = new RenderGraph();
      const backbuffer = graph.importTexture('backbuffer', surface);
      const color = graph.createTexture('color', { format: 'rgba8unorm' });
      const first = graph.addRasterPass('first', (pass) => ({
        color: pass.writeColor(color, { load: 'clear' }),
        execute: () => undefined,
      }));
      const second = graph.addRasterPass('second', (pass) => ({
        color: pass.writeColor(first.color, { load }),
        execute: () => undefined,
      }));
      graph.addRasterPass('final', (pass) => {
        pass.read(second.color, 'sampled');
        return {
          color: pass.writeColor(backbuffer, { load: 'clear' }),
          execute: () => undefined,
        };
      });
      return graph.compile();
    };
    expect(build('load').culled).toEqual([]);
    expect(build('clear').culled).toEqual(['first']);
  });

  it('keeps the passes with side effects', () => {
    const graph = new RenderGraph();
    const data = graph.createBuffer('data', { size: 16 });
    graph.addComputePass('capture', (pass) => {
      pass.write(data, 'storage-write');
      pass.hasSideEffects();
      return { execute: () => undefined };
    });
    expect(graph.compile().order).toEqual([0]);
  });

  it('runs the readers of a version before the next writer', () => {
    const graph = new RenderGraph();
    const color = graph.createTexture('color', { format: 'rgba8unorm' });
    const first = graph.addRasterPass('first', (pass) => ({
      color: pass.writeColor(color, { load: 'clear' }),
      execute: () => undefined,
    }));
    const second = graph.addRasterPass('second', (pass) => ({
      color: pass.writeColor(first.color, { load: 'load' }),
      execute: () => undefined,
    }));
    // A pass uses a resource once: reading two versions is refused.
    expect(() =>
      graph.addRasterPass('reader', (pass) => {
        pass.read(first.color, 'sampled');
        pass.read(second.color, 'copy-src');
        return { execute: () => undefined };
      })
    ).toThrow(/uses "color" twice/);

    const ordered = new RenderGraph();
    const target = ordered.importTexture('backbuffer', surface);
    const texture = ordered.createTexture('color', { format: 'rgba8unorm' });
    const a = ordered.addRasterPass('a', (pass) => ({
      color: pass.writeColor(texture, { load: 'clear' }),
      execute: () => undefined,
    }));
    const b = ordered.addRasterPass('b', (pass) => ({
      color: pass.writeColor(a.color, { load: 'load' }),
      execute: () => undefined,
    }));
    const c = ordered.addRasterPass('c', (pass) => {
      pass.read(a.color, 'sampled');
      return {
        color: pass.writeColor(target, { load: 'clear' }),
        execute: () => undefined,
      };
    });
    ordered.addRasterPass('d', (pass) => {
      pass.read(b.color, 'sampled');
      return {
        color: pass.writeColor(c.color, { load: 'load' }),
        execute: () => undefined,
      };
    });
    // 'c' reads the version written by 'a': before 'b' overwrites it.
    expect(ordered.compile().order).toEqual([0, 2, 1, 3]);
  });

  it('reports the misuses of resources', () => {
    const graph = new RenderGraph();
    const color = graph.createTexture('color', { format: 'rgba8unorm' });
    expect(() => graph.createTexture('color', { format: 'r8unorm' })).toThrow(
      /already has a resource "color"/
    );
    graph.addRasterPass('first', (pass) => ({
      color: pass.writeColor(color, { load: 'clear' }),
      execute: () => undefined,
    }));
    // Writing a version already written since.
    expect(() =>
      graph.addRasterPass('second', (pass) => ({
        color: pass.writeColor(color, { load: 'clear' }),
        execute: () => undefined,
      }))
    ).toThrow(/write its latest version/);

    const unwritten = new RenderGraph();
    const backbuffer = unwritten.importTexture('backbuffer', surface);
    const empty = unwritten.createTexture('empty', { format: 'rgba8unorm' });
    unwritten.addRasterPass('reader', (pass) => {
      pass.read(empty, 'sampled');
      return {
        color: pass.writeColor(backbuffer, { load: 'clear' }),
        execute: () => undefined,
      };
    });
    expect(() => unwritten.compile()).toThrow(
      /reads "empty" before any pass writes it/
    );
  });
});

describe('RenderGraphRunner', () => {
  // A temporary texture rendered, then sampled into the backbuffer.
  const twoPasses = (
    log: { events: string[] },
    size?: { relative: number }
  ) => {
    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer', surface);
    const color = graph.createTexture('color', {
      format: 'rgba16float',
      ...(size ? { size } : {}),
    });
    const first = graph.addRasterPass('render', (pass) => ({
      color: pass.writeColor(color, {
        load: 'clear',
        clearValue: { r: 1, g: 0, b: 0, a: 1 },
      }),
      execute: run(log, 'render'),
    }));
    graph.addRasterPass('present', (pass) => {
      pass.read(first.color, 'sampled');
      return {
        color: pass.writeColor(backbuffer, { load: 'clear' }),
        execute: (context) => {
          run(log, 'present')();
          // The real texture of the handle.
          expect(context.texture(first.color)).toBe(
            (log as { textures?: unknown[] }).textures?.at(-1) ??
              context.texture(first.color)
          );
        },
      };
    });
    return graph;
  };

  it('records the passes in order with their attachments', () => {
    const { backend, log } = fakeBackend();
    const runner = new RenderGraphRunner(backend);
    runner.execute(twoPasses(log));
    expect(log.events).toEqual([
      'render render',
      'run render',
      'end',
      'render present',
      'run present',
      'end',
      'submit',
    ]);
    const [render, present] = log.renderPasses;
    expect(render.colorAttachments[0]).toMatchObject({
      target: log.textures[0],
      load: 'clear',
      clearValue: { r: 1, g: 0, b: 0, a: 1 },
    });
    expect(present.colorAttachments[0].target).toBe(surface);
  });

  it('creates the transient resources with the union of their usages', () => {
    const { backend, log } = fakeBackend();
    new RenderGraphRunner(backend).execute(twoPasses(log));
    expect(log.textures).toHaveLength(1);
    expect(log.textures[0]).toMatchObject({
      format: 'rgba16float',
      dimensions: { width: 64, height: 32 },
      usage: ['render-attachment', 'sampled'],
    });
  });

  it('sizes the textures relatively to the frame', () => {
    const { backend, log } = fakeBackend();
    new RenderGraphRunner(backend).execute(twoPasses(log, { relative: 0.5 }), {
      size: { width: 100, height: 50 },
    });
    expect(log.textures[0].dimensions).toEqual({ width: 50, height: 25 });
  });

  it('reuses the compilation and the resources from frame to frame', () => {
    const { backend, log } = fakeBackend();
    const runner = new RenderGraphRunner(backend, { keepFrames: 1 });
    for (let frame = 0; frame < 3; frame++) {
      runner.execute(twoPasses(log));
    }
    expect(runner.compilations).toBe(1);
    expect(runner.created).toBe(1);

    // Another size: other resources; the unused ones are destroyed.
    runner.execute(twoPasses(log), { size: { width: 32, height: 32 } });
    runner.execute(twoPasses(log), { size: { width: 32, height: 32 } });
    runner.execute(twoPasses(log), { size: { width: 32, height: 32 } });
    expect(runner.created).toBe(2);
    expect(log.destroyed).toEqual(['color']);
  });

  it('emits the transitions on backends with explicit synchronization', () => {
    const { backend, log } = fakeBackend({ explicitTransitions: true });
    const compiled = new RenderGraphRunner(backend).execute(twoPasses(log));
    expect(compiled.transitions).toEqual([
      [],
      [{ resource: 'color', from: 'color-attachment', to: 'sampled' }],
    ]);
    expect(log.transitions).toHaveLength(1);
    expect(log.transitions[0][0]).toMatchObject({
      resource: log.textures[0],
      from: 'color-attachment',
      to: 'sampled',
    });
  });

  it('opens a compute pass for compute passes', () => {
    const { backend, log } = fakeBackend();
    const graph = new RenderGraph();
    const data = graph.createBuffer('data', { size: 64 });
    const filled = graph.addComputePass('fill', (pass) => ({
      data: pass.write(data, 'storage-write'),
      execute: run(log, 'fill'),
    }));
    graph.addCopyPass('read back', (pass) => {
      pass.read(filled.data, 'copy-src');
      pass.hasSideEffects();
      return { execute: run(log, 'read back') };
    });
    new RenderGraphRunner(backend).execute(graph);
    expect(log.events).toEqual([
      'compute fill',
      'run fill',
      'end',
      'run read back',
      'submit',
    ]);
    expect(log.buffers[0].usage).toEqual(['storage', 'copy-src']);
  });

  it('only gives the resources a pass declared', () => {
    const { backend, log } = fakeBackend();
    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer', surface);
    const other = graph.importTexture('other', surface);
    graph.addRasterPass('pass', (pass) => ({
      color: pass.writeColor(backbuffer, { load: 'clear' }),
      execute: (context) => {
        context.texture(other);
      },
    }));
    expect(() => new RenderGraphRunner(backend).execute(graph)).toThrow(
      /uses "other" without declaring it/
    );
    void log;
  });
});

describe('RenderGraphRunner, memory and debugging', () => {
  // a → b → c → backbuffer: the lifetimes of a and c do not overlap.
  const chain = (log: { events: string[] }) => {
    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer', surface);
    const texture = (name: string) =>
      graph.createTexture(name, { format: 'rgba16float' });
    let previous: ReturnType<typeof texture> | undefined;
    const written: Record<string, ReturnType<typeof texture>> = {};
    for (const name of ['a', 'b', 'c']) {
      const source = previous;
      previous = graph.addRasterPass(`draw ${name}`, (pass) => {
        if (source) {
          pass.read(source, 'sampled');
        }
        return {
          color: pass.writeColor(texture(name), { load: 'clear' }),
          execute: run(log, name),
        };
      }).color;
      written[name] = previous;
    }
    const last = previous as ReturnType<typeof texture>;
    graph.addRasterPass('present', (pass) => {
      pass.read(last, 'sampled');
      return {
        color: pass.writeColor(backbuffer, { load: 'clear' }),
        execute: run(log, 'present'),
      };
    });
    return { graph, written };
  };

  it('reuses the memory of a resource for a later one of the frame', () => {
    const { backend, log } = fakeBackend();
    const runner = new RenderGraphRunner(backend);
    const { graph, written } = chain(log);
    const textures: Record<string, unknown> = {};
    // Records the real textures through the context of the passes.
    for (const pass of graph.passes) {
      const execute = pass.execute as (context: never) => void;
      pass.execute = (context: never) => {
        const { texture } = context as {
          texture: (handle: unknown) => unknown;
        };
        for (const [name, handle] of Object.entries(written)) {
          try {
            textures[name] = texture(handle);
          } catch {
            // Not declared by this pass.
          }
        }
        execute(context);
      };
    }
    const compiled = runner.execute(graph);
    expect(compiled.acquires).toEqual([[1], [2], [3], []]);
    expect(compiled.releases).toEqual([[], [1], [2], [3]]);
    // a is free when c starts.
    expect(runner.created).toBe(2);
    expect(textures['c']).toBe(textures['a']);
    expect(textures['b']).not.toBe(textures['a']);
  });

  it('gives the size of the textures to the passes', () => {
    const { backend } = fakeBackend();
    const graph = new RenderGraph();
    const half = graph.createTexture('half', {
      format: 'rgba8unorm',
      size: { relative: 0.5 },
    });
    const sizes: unknown[] = [];
    graph.addRasterPass('fill', (pass) => {
      pass.hasSideEffects();
      return {
        color: pass.writeColor(half, { load: 'clear' }),
        execute: (context) => sizes.push(context.size(half)),
      };
    });
    expect(graph.textureSize(half)).toEqual({ relative: 0.5 });
    new RenderGraphRunner(backend).execute(graph, {
      size: { width: 64, height: 32 },
    });
    expect(sizes).toEqual([{ width: 32, height: 16 }]);
  });

  it('resolves multisampled attachments into textures', () => {
    const { backend, log } = fakeBackend();
    const graph = new RenderGraph();
    const backbuffer = graph.importTexture('backbuffer', surface);
    const samples = graph.createTexture('samples', {
      format: 'rgba8unorm',
      sampleCount: 4,
    });
    expect(graph.textureSize(backbuffer)).toEqual({ width: 64, height: 32 });
    graph.addRasterPass('draw', (pass) => {
      pass.writeColor(samples, { load: 'clear' });
      return {
        color: pass.resolveColor(backbuffer),
        execute: run(log, 'draw'),
      };
    });
    new RenderGraphRunner(backend).execute(graph);
    expect(log.textures[0]).toMatchObject({
      sampleCount: 4,
      usage: ['render-attachment'],
    });
    expect(log.renderPasses[0].colorAttachments[0]).toMatchObject({
      target: log.textures[0],
      resolveTarget: surface,
    });
    // Nothing to resolve.
    const wrong = new RenderGraph();
    const texture = wrong.importTexture('backbuffer', surface);
    expect(() =>
      wrong.addRasterPass('draw', (pass) => ({
        color: pass.resolveColor(texture),
        execute: () => undefined,
      }))
    ).toThrow(/without a color attachment to resolve/);
  });

  it('describes the graph for Graphviz', () => {
    const { graph } = chain({ events: [] });
    const unused = graph.createTexture('unused', { format: 'rgba8unorm' });
    graph.addRasterPass('culled', (pass) => ({
      color: pass.writeColor(unused, { load: 'clear' }),
      execute: () => undefined,
    }));
    const dot = graph.toDot();
    expect(dot).toMatch(/^digraph "render graph" \{/);
    expect(dot).toContain('p0 [shape=box, label="1. draw a"];');
    expect(dot).toContain(
      'p4 [shape=box, label="culled", style=dashed, color=gray];'
    );
    expect(dot).toContain('p0 -> r1v1 [label="color-attachment"];');
    expect(dot).toContain('r1v1 -> p1 [label="sampled"];');
    expect(dot).toContain('r0v1 [shape=doubleoctagon, label="backbuffer #1"];');
  });
});
