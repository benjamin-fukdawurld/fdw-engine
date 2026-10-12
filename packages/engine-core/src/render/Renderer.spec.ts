import {
  GraphBuilder,
  arrayType,
  engineUniformBlocks,
  MaxLights,
  std,
  stdMacros,
  BuiltinTypes,
} from '@fdw/engine-shader';
import { describe, expect, it } from 'vitest';
import { Camera } from '../Camera';
import { DirectionalLight, PointLight, SpotLight } from '../light';
import { Transform } from '../Transform';
import { Material, RenderState } from './Material';
import { Mesh } from './Mesh';
import { RenderGraph } from '../graph/RenderGraph';
import { RenderGraphRunner } from '../graph/RenderGraphRunner';
import { Renderer } from './Renderer';
import {
  colorGraph,
  fakeBackend,
  FakeBuffer,
  rowOf,
  sizeOf,
  surface,
  texturedGraph,
  triangle,
} from '../testing/fakeBackend';

const transformAt = (x: number, z = 0) =>
  new Transform({ position: { x, y: 0, z } });

const setup = () => {
  const { backend, log } = fakeBackend();
  const renderer = new Renderer(backend);
  const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
  const render = (items: Parameters<Renderer['render']>[0]['items']) =>
    renderer.render({ items, camera, surface });
  return { renderer, render, log, camera };
};

const floatsOf = (buffer: FakeBuffer) => [...new Float32Array(buffer.data)];

describe('Renderer', () => {
  it('draws the items and submits once per frame', () => {
    const { render, log } = setup();
    const material = new Material({ graph: colorGraph() });
    render([{ mesh: triangle(), material, transform: transformAt(0) }]);
    expect(log.draws).toEqual([
      expect.objectContaining({ count: 3, indexed: true }),
    ]);
    expect(log.submits).toBe(1);
  });

  it('creates programs, pipelines and mesh buffers once', () => {
    const { render, log } = setup();
    const mesh = triangle();
    const graph = colorGraph();
    const a = new Material({ graph });
    const b = new Material({ graph, values: { color: [0, 1, 0] } });
    const items = [
      { mesh, material: a, transform: transformAt(0) },
      { mesh, material: b, transform: transformAt(1) },
    ];
    render(items);
    const buffers = log.buffers.length;
    render(items);
    render(items);

    // Same graph and render state: one pipeline for both materials.
    expect(log.pipelines).toHaveLength(1);
    expect(log.buffers).toHaveLength(buffers);
    expect(log.draws).toHaveLength(6);
  });

  it('uploads material uniforms only when the values change', () => {
    const { render, log } = setup();
    const material = new Material({ graph: colorGraph() });
    const items = [{ mesh: triangle(), material, transform: transformAt(0) }];
    render(items);
    const buffer = log.buffers.find((b) =>
      b.label?.includes('color uniforms')
    ) as FakeBuffer;
    expect(floatsOf(buffer).slice(0, 3)).toEqual([1, 0, 0]);

    render(items);
    expect(buffer.writes).toBe(1);

    material.setValue('color', [0, 0, 1]);
    render(items);
    expect(buffer.writes).toBe(2);
    expect(floatsOf(buffer).slice(0, 3)).toEqual([0, 0, 1]);
  });

  it('writes the row of an object only when its transform changes', () => {
    const { render, log } = setup();
    const transform = transformAt(2);
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform,
      },
    ];
    render(items);
    expect(rowOf(log, 0)[12]).toBe(2);
    expect(log.rowWrites).toHaveLength(1);

    render(items);
    expect(log.rowWrites).toHaveLength(1);

    transform.position = { x: 5 };
    render(items);
    expect(log.rowWrites).toHaveLength(2);
    expect(rowOf(log, 0)[12]).toBe(5);
  });

  it('writes the camera in the frame uniforms every frame', () => {
    const { render, log, camera } = setup();
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    render(items);
    const buffer = log.buffers.find(
      (b) => b.label === 'scene frame uniforms'
    ) as FakeBuffer;
    // viewProjection: the fake projection of a translation by -position,
    // whose depth is 0.5 + 0.0005 z.
    expect(floatsOf(buffer)[14]).toBeCloseTo(0.505, 6);

    camera.position = { z: 3 };
    render(items);
    expect(floatsOf(buffer)[14]).toBeCloseTo(0.5015, 6);
  });

  it('binds textures and rebuilds the bind group when one changes', () => {
    const { render, log } = setup();
    const texture = {
      type: '2d',
      format: 'rgba8unorm',
      dimensions: { width: 1 },
      destroy: () => undefined,
    } as const;
    const other = { ...texture };
    const sampler = { destroy: () => undefined };
    const material = new Material({
      graph: texturedGraph(),
      values: { map: texture, mapSampler: sampler },
    });
    const items = [{ mesh: triangle(), material, transform: transformAt(0) }];

    render(items);
    const materialGroups = () =>
      log.bindGroups.filter((group) => group.key.includes('"map"'));
    expect(materialGroups()).toHaveLength(1);
    expect(materialGroups()[0].entries.map((entry) => entry.resource)).toEqual([
      texture,
      sampler,
    ]);

    render(items);
    expect(materialGroups()).toHaveLength(1);

    material.setValue('map', other);
    render(items);
    expect(materialGroups()).toHaveLength(2);
    expect(materialGroups()[1].entries[0].resource).toBe(other);
  });

  it('binds the storage buffers of the materials', () => {
    const { render, log } = setup();
    const g = new GraphBuilder('palette');
    const palette = g.storage('palette', arrayType(BuiltinTypes.vec4f));
    g.surface({
      baseColor: g.call(std.index, { array: palette, index: 0 }).swizzle('rgb'),
    });
    const buffer = new FakeBuffer(32, 'palette');
    render([
      {
        mesh: triangle(),
        material: new Material({
          graph: g.build(),
          values: { palette: buffer },
        }),
        transform: transformAt(0),
      },
    ]);
    const group = log.bindGroups.find((candidate) =>
      candidate.entries.some((entry) => entry.resource === buffer)
    );
    expect(group?.entries).toEqual([{ binding: 0, resource: buffer }]);
  });

  it('reports a missing texture with the material name', () => {
    const { render } = setup();
    const material = new Material({ graph: texturedGraph(), label: 'wood' });
    expect(() =>
      render([{ mesh: triangle(), material, transform: transformAt(0) }])
    ).toThrow('Material "wood": no texture set for "map"');
  });

  it('shares the frame and object bind groups between programs', () => {
    const { render, log } = setup();
    const transform = transformAt(0);
    render([
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph('a') }),
        transform,
      },
      {
        mesh: triangle(),
        material: new Material({
          graph: texturedGraph(),
          values: { map: {}, mapSampler: {} } as never,
        }),
        transform,
      },
    ]);
    const [first, second] = log.draws;
    expect(first.groups[0]).toBe(second.groups[0]);
    expect(first.groups[2]).toBe(second.groups[2]);
    expect(first.groups[1]).not.toBe(second.groups[1]);
  });

  it('draws opaque items first, then transparent ones back to front', () => {
    const { render, log } = setup();
    const opaque = new Material({ graph: colorGraph(), label: 'opaque' });
    const glass = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
      label: 'glass',
    });
    render([
      { mesh: triangle(), material: glass, transform: transformAt(0, 5) },
      { mesh: triangle(), material: opaque, transform: transformAt(0) },
      { mesh: triangle(), material: glass, transform: transformAt(0, -5) },
    ]);
    expect(log.draws.map((draw) => draw.pipeline)).toEqual([
      'opaque',
      'glass',
      'glass',
    ]);
    // The instances of the transparent pass: the far object (z = -5, 15
    // from the camera), then the near one.
    expect([...log.lastInstances].map((row) => rowOf(log, row)[14])).toEqual([
      -5, 5,
    ]);
  });

  it('draws masked materials with the opaque ones, with their cutoff', () => {
    const { render, log } = setup();
    const glass = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
      label: 'glass',
    });
    const leaves = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'mask' },
      label: 'leaves',
    });
    render([
      { mesh: triangle(), material: glass, transform: transformAt(0) },
      { mesh: triangle(), material: leaves, transform: transformAt(1) },
    ]);
    expect(log.draws.map((draw) => draw.pipeline)).toEqual(['leaves', 'glass']);
    const pipeline = log.pipelines.find((p) => p.label === 'leaves');
    expect(pipeline?.targets[0].blend).toBeUndefined();
    expect(pipeline?.depthStencil?.depthWrite).toBe(true);
    expect(pipeline?.program.variantKey).toEqual({
      alphaMode: 'mask',
      toneMapping: 'none',
      outputEncoding: 'srgb',
    });
    // alphaCutoff (0.5 by default) comes first in the block, sorted by name.
    const uniforms = log.buffers.find((b) => b.label === 'leaves uniforms');
    expect(floatsOf(uniforms as FakeBuffer)[0]).toBe(0.5);

    leaves.setValue('alphaCutoff', 0.25);
    render([{ mesh: triangle(), material: leaves, transform: transformAt(1) }]);
    expect(floatsOf(uniforms as FakeBuffer)[0]).toBe(0.25);
  });

  it('derives the pipeline state from the render state', () => {
    const { render, log } = setup();
    render([
      {
        mesh: triangle(),
        material: new Material({
          graph: colorGraph(),
          renderState: { doubleSided: true, depthWrite: false },
        }),
        transform: transformAt(0),
      },
    ]);
    const [pipeline] = log.pipelines;
    expect(pipeline.primitive.cullMode).toBe('none');
    expect(pipeline.depthStencil).toEqual({
      format: 'depth24plus',
      depthWrite: false,
      depthCompare: 'less',
    });
    expect(pipeline.targets[0].blend).toBeUndefined();
  });

  it('draws double-sided transparent items back faces first', () => {
    const { render, log } = setup();
    render([
      {
        mesh: triangle(),
        material: new Material({
          graph: colorGraph(),
          renderState: { doubleSided: true, alphaMode: 'blend' },
          label: 'glass',
        }),
        transform: transformAt(0),
      },
    ]);
    expect(log.pipelines.map((p) => p.primitive.cullMode)).toEqual([
      'front',
      'back',
    ]);
    expect(log.draws).toHaveLength(2);
    expect(log.pipelines[0].targets[0].blend).toBeDefined();
  });
});

describe('Renderer, object table', () => {
  const tabled = () => {
    const { backend, log } = fakeBackend({
      maxVaryings: 16,
      storageBuffers: true,
      compute: true,
      objectTable: true,
    });
    const renderer = new Renderer(backend);
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    const render = (items: Parameters<Renderer['render']>[0]['items']) =>
      renderer.render({ items, camera, surface });
    return { renderer, render, log };
  };

  it('draws each object as an instance of the table, its group bound once', () => {
    const { render, log } = tabled();
    const material = new Material({ graph: colorGraph() });
    const mesh = triangle();
    const items = [-1, 0, 1].map((x) => ({
      mesh,
      material,
      transform: transformAt(x),
    }));
    render(items);
    expect(log.objectTables).toHaveLength(1);
    // The same mesh and material: one draw of three instances.
    expect(
      log.draws.map(({ instances, firstInstance }) => [
        instances,
        firstInstance,
      ])
    ).toEqual([[3, 0]]);
    // No buffer per object.
    expect(log.buffers.filter((b) => b.label === 'object uniforms')).toEqual(
      []
    );
    // The three rows in one write, then the instances of the pass.
    expect(log.rowWrites).toEqual([{ first: 0, bytes: 3 * 112 }]);
    expect(log.instanceWrites).toEqual([{ first: 0, count: 3 }]);
    expect([...log.lastInstances].sort()).toEqual([0, 1, 2]);
    const objectGroups = new Set(log.draws.map((draw) => draw.groups[2]));
    expect(objectGroups.size).toBe(1);
  });

  it('grows the table, every row written in the new one', () => {
    const { render, log } = tabled();
    const material = new Material({ graph: colorGraph() });
    const mesh = triangle();
    const items = Array.from({ length: 300 }, (_, i) => ({
      mesh,
      material,
      transform: transformAt(i / 100 - 1.5),
    }));
    render(items);
    // The first table, then a larger one for 300 objects.
    expect(log.objectTables.length).toBeGreaterThan(0);
    const last = log.objectTables.at(-1) as { rows: number; instances: number };
    expect(last.rows).toBeGreaterThanOrEqual(300);
    expect(last.instances).toBeGreaterThanOrEqual(300);
    expect(log.rowWrites.at(-1)).toEqual({ first: 0, bytes: 300 * 112 });
    expect(log.draws.map((draw) => draw.instances)).toEqual([300]);
  });

  it('instances the items sharing a mesh and a material, sorted together', () => {
    const { renderer, render, log } = tabled();
    const red = new Material({ graph: colorGraph() });
    const blue = new Material({ graph: colorGraph() });
    const cube = triangle();
    const ball = triangle();
    // Interleaved: the sort gathers them by material, then by mesh.
    const items = [
      { mesh: cube, material: red, transform: transformAt(-1) },
      { mesh: ball, material: red, transform: transformAt(0) },
      { mesh: cube, material: blue, transform: transformAt(1) },
      { mesh: cube, material: red, transform: transformAt(2) },
      { mesh: ball, material: red, transform: transformAt(3) },
    ];
    render(items);
    expect(log.draws.map((draw) => draw.instances)).toEqual([2, 2, 1]);
    expect(renderer.stats.get('scene')).toMatchObject({
      drawn: 5,
      drawCalls: 3,
    });
  });

  it('rewrites only the rows of the objects that moved', () => {
    const { render, log } = tabled();
    const material = new Material({ graph: colorGraph() });
    const mesh = triangle();
    const transforms = [0, 1, 2].map((x) => transformAt(x));
    const items = transforms.map((transform) => ({
      mesh,
      material,
      transform,
    }));
    render(items);
    log.rowWrites.length = 0;
    render(items);
    expect(log.rowWrites).toEqual([]);
    transforms[1].position = { x: 5 };
    render(items);
    expect(log.rowWrites).toEqual([{ first: 1, bytes: 112 }]);
    // Each frame starts its instances over.
    expect(log.instanceWrites.at(-1)).toEqual({ first: 0, count: 3 });
  });
});

describe('Renderer on the render graph', () => {
  it('draws the transparent items in a second pass, only when there are some', () => {
    const { render, log } = setup();
    const opaque = new Material({ graph: colorGraph() });
    render([{ mesh: triangle(), material: opaque, transform: transformAt(0) }]);
    expect(log.renderPasses).toEqual(['scene opaque']);

    const glass = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
    });
    render([
      { mesh: triangle(), material: opaque, transform: transformAt(0) },
      { mesh: triangle(), material: glass, transform: transformAt(1) },
    ]);
    expect(log.renderPasses).toEqual([
      'scene opaque',
      'scene opaque',
      'scene transparent',
    ]);
  });

  it('keeps its depth texture from frame to frame', () => {
    const { render, log } = setup();
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    render(items);
    render(items);
    render(items);
    expect(log.textures).toHaveLength(1);
    expect(log.textures[0]).toMatchObject({
      format: 'depth24plus',
      dimensions: { width: 4, height: 4 },
      usage: ['render-attachment'],
    });
  });

  it('adds the scene passes to a render graph', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const graph = new RenderGraph();
    const color = graph.createTexture('hdr', {
      format: 'rgba16float',
      size: { width: 8, height: 8 },
    });
    const scene = renderer.addScenePasses(graph, {
      items: [
        {
          mesh: triangle(),
          material: new Material({ graph: colorGraph() }),
          transform: transformAt(0),
        },
      ],
      camera: new Camera(),
      target: color,
      format: 'rgba16float',
    });
    graph.addCopyPass('capture', (pass) => {
      pass.read(scene, 'copy-src');
      pass.hasSideEffects();
      return { execute: () => log.renderPasses.push('capture') };
    });
    new RenderGraphRunner(backend).execute(graph);
    expect(log.renderPasses).toEqual(['scene opaque', 'capture']);
    expect(log.draws).toHaveLength(1);
  });
});

describe('Renderer, HDR', () => {
  const hdrSetup = (
    options: ConstructorParameters<typeof Renderer>[1] = {}
  ) => {
    const { backend, log } = fakeBackend({
      renderableFormats: ['rgba16float'],
    });
    const renderer = new Renderer(backend, options);
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    const render = (items: Parameters<Renderer['render']>[0]['items']) =>
      renderer.render({ items, camera, surface });
    return { renderer, render, log, backend };
  };
  const item = (material = new Material({ graph: colorGraph() })) => ({
    mesh: triangle(),
    material,
    transform: transformAt(0),
  });

  it('renders linear colors in an HDR target, then tone maps them', () => {
    const { render, log } = hdrSetup({ output: { toneMapping: 'aces' } });
    render([item()]);
    expect(log.renderPasses).toEqual(['scene opaque', 'tone mapping']);
    expect(log.textures.map((texture) => texture.format).sort()).toEqual([
      'depth24plus',
      'rgba16float',
    ]);
    const [scene, toneMapping] = log.pipelines;
    expect(scene.targets).toEqual([
      expect.objectContaining({ format: 'rgba16float' }),
    ]);
    // The materials write linear colors: no output variant.
    expect(scene.program.variantKey).not.toHaveProperty('toneMapping', 'aces');
    expect(toneMapping.label).toBe('tone mapping');
    expect(toneMapping.targets).toEqual([{ format: 'rgba8unorm' }]);
    expect(toneMapping.program.vertexInputs).toEqual([]);
    // A triangle covering the target, without index nor vertex buffer.
    expect(log.draws[1]).toMatchObject({
      pipeline: 'tone mapping',
      count: 3,
      indexed: false,
    });
  });

  it('applies the output in the materials when HDR is disabled', () => {
    const { render, log } = hdrSetup({ hdr: false });
    render([item()]);
    expect(log.renderPasses).toEqual(['scene opaque']);
    expect(log.pipelines[0].targets).toEqual([
      expect.objectContaining({ format: 'rgba8unorm' }),
    ]);
  });

  it('keeps its pipelines and bind groups from frame to frame', () => {
    const { render, log } = hdrSetup();
    const items = [item()];
    render(items);
    const pipelines = log.pipelines.length;
    const bindGroups = log.bindGroups.length;
    render(items);
    render(items);
    expect(log.pipelines).toHaveLength(pipelines);
    // The pooled HDR texture does not change: no new bind group.
    expect(log.bindGroups).toHaveLength(bindGroups);
    expect(log.textures).toHaveLength(2);
  });

  it('adds full screen passes reading textures of the graph', () => {
    const { renderer, log } = hdrSetup();
    const g = new GraphBuilder('invert');
    const texel = g.call(std.textureSample, {
      texture: g.texture('source'),
      sampler: g.sampler('sourceSampler'),
      uv: g.builtin('screen-uv'),
    });
    g.fullscreen({
      color: g.call(std.extend, {
        xyz: g.call(std.sub, { a: 1, b: texel.swizzle('rgb') }),
        w: 1,
      }),
    });
    const invert = new Material({
      graph: g.build(),
      values: { sourceSampler: { destroy: () => undefined } },
    });

    const graph = new RenderGraph();
    const size = { width: 8, height: 8 };
    const color = graph.createTexture('color', { format: 'rgba8unorm', size });
    const scene = renderer.addScenePasses(graph, {
      items: [item()],
      camera: new Camera(),
      target: color,
      format: 'rgba8unorm',
    });
    const inverted = renderer.addFullscreenPass(graph, 'invert', {
      material: invert,
      inputs: { source: scene },
      target: graph.createTexture('inverted', { format: 'rgba8unorm', size }),
      format: 'rgba8unorm',
    });
    graph.addCopyPass('capture', (pass) => {
      pass.read(inverted, 'copy-src');
      pass.hasSideEffects();
      return { execute: () => log.renderPasses.push('capture') };
    });
    new RenderGraphRunner(renderer.backend).execute(graph);
    expect(log.renderPasses).toEqual(['scene opaque', 'invert', 'capture']);
    // The texture of the scene, sampled by the pass.
    const sceneTexture = log.textures.find(
      (texture) => texture.label === 'color'
    );
    expect(sceneTexture?.usage).toEqual(
      expect.arrayContaining(['render-attachment', 'sampled'])
    );
    expect(invert.getValue('source')).toMatchObject({ label: 'color' });
  });
});

describe('Renderer, shadows', () => {
  // Lit, with a constant normal: the triangle has no normals.
  const litGraph = () => {
    const g = new GraphBuilder('lit');
    g.surface({
      shadingModel: 'phong',
      baseColor: [1, 1, 1],
      normal: [0, 0, 1],
    });
    return g.build();
  };
  const lit = (options: { castShadow?: boolean; blend?: boolean } = {}) => ({
    mesh: triangle(),
    material: new Material({
      graph: litGraph(),
      ...(options.blend
        ? { renderState: { alphaMode: 'blend' as const } }
        : {}),
    }),
    transform: transformAt(0),
    ...(options.castShadow === undefined
      ? {}
      : { castShadow: options.castShadow }),
  });
  const shadowSetup = () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend, { shadowAtlasSize: 1024 });
    const camera = new Camera({ position: { x: 0, y: 0, z: 10 } });
    return { renderer, log, camera };
  };
  const sun = () =>
    new DirectionalLight({
      direction: { x: 0, y: -1, z: 0 },
      castShadow: true,
    });

  it('draws the shadow maps of the lights into the tiles of an atlas', () => {
    const { renderer, log, camera } = shadowSetup();
    renderer.render({
      items: [lit()],
      camera,
      surface,
      lights: [
        sun(),
        // Point lights cast no shadows.
        new PointLight({ position: { x: 0, y: 1, z: 0 } }),
        new SpotLight({
          position: { x: 0, y: 5, z: 0 },
          direction: { x: 0, y: -1, z: 0 },
          castShadow: true,
        }),
      ],
    });
    expect(log.renderPasses).toEqual(['scene shadows', 'scene opaque']);
    // Two lights: a 2 × 2 grid of tiles.
    expect(log.viewports).toEqual([
      [0, 0, 512, 512],
      [512, 0, 512, 512],
    ]);
    const atlas = log.textures.find((t) => t.label === 'scene shadows atlas');
    expect(atlas).toMatchObject({
      format: 'depth24plus',
      dimensions: { width: 1024, height: 1024 },
    });
    expect(atlas?.usage).toEqual(
      expect.arrayContaining(['render-attachment', 'sampled'])
    );
    // Depth only, with a slope bias; the scene reads the atlas.
    const [depthOnly, scene] = log.pipelines;
    expect(depthOnly.targets).toEqual([]);
    expect(depthOnly.depthStencil).toMatchObject({
      depthBias: 2,
      depthBiasSlopeScale: 2,
    });
    expect(depthOnly.program.variantKey).toMatchObject({ depthOnly: true });
    expect(scene.program.variantKey).toMatchObject({ shadows: true });
    // A draw per light in the shadow pass, then the scene.
    expect(log.draws).toHaveLength(3);
  });

  it('writes the tiles and matrices of the lights in the frame uniforms', () => {
    const { renderer, log, camera } = shadowSetup();
    renderer.render({
      items: [lit()],
      camera,
      surface,
      lights: [new PointLight(), sun()],
    });
    const frame = log.buffers.find(
      (b) => b.label === 'scene frame uniforms'
    ) as FakeBuffer;
    const floats = floatsOf(frame);
    const index = (name: string) => {
      let offset = 0;
      for (const member of engineUniformBlocks.frame) {
        if (member.name === name) {
          return offset / 4;
        }
        offset += sizeOf(member.type);
      }
      throw new Error(name);
    };
    const vec4 = (name: string, light: number) =>
      floats.slice(index(name) + light * 4, index(name) + light * 4 + 4);
    // The point light has no tile; the sun has the whole atlas.
    expect(vec4('lightShadows', 0)).toEqual([0, 0, 0, 0]);
    expect(vec4('lightShadows', 1)[0]).toBe(1);
    expect(vec4('lightShadows', 1)[3]).toBeCloseTo(1 / 1024);
    expect(vec4('lightShadowRects', 1)).toEqual([0, 0, 1, 1]);
  });

  it('leaves out the items that do not cast shadows', () => {
    const { renderer, log, camera } = shadowSetup();
    renderer.render({
      items: [lit(), lit({ castShadow: false }), lit({ blend: true })],
      camera,
      surface,
      lights: [sun()],
    });
    // One caster, then three items in the scene.
    expect(log.draws).toHaveLength(4);
    expect(log.renderPasses).toEqual([
      'scene shadows',
      'scene opaque',
      'scene transparent',
    ]);
  });

  it('has no shadow pass without lights casting shadows', () => {
    const { renderer, log, camera } = shadowSetup();
    renderer.render({
      items: [lit()],
      camera,
      surface,
      lights: [new DirectionalLight()],
    });
    expect(log.renderPasses).toEqual(['scene opaque']);
    expect(log.pipelines[0].program.variantKey).not.toHaveProperty(
      'shadows',
      true
    );
    // Shadows can be turned off per scene.
    const graph = new RenderGraph();
    renderer.addScenePasses(graph, {
      items: [lit()],
      camera,
      lights: [sun()],
      target: graph.importTexture('surface', surface.getCurrentTarget()),
      format: surface.format,
      shadows: false,
    });
    expect(graph.passes.map((pass) => pass.name)).toEqual(['scene opaque']);
  });
});

describe('Renderer, views', () => {
  it('gives each scene of a graph its own frame uniforms', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const graph = new RenderGraph();
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    for (const [name, x] of [
      ['left', 1],
      ['right', 2],
    ] as const) {
      renderer.addScenePasses(graph, {
        items,
        camera: new Camera({ position: { x, y: 0, z: 0 } }),
        target: graph.createTexture(name, { format: 'rgba8unorm' }),
        format: 'rgba8unorm',
        name,
      });
    }
    const frames = log.buffers.filter((b) =>
      b.label?.endsWith('frame uniforms')
    );
    // The fake view matrix is a translation by -position, scaled by the
    // fake projection: both cameras are kept until the graph runs.
    expect(frames.map((buffer) => floatsOf(buffer)[12])).toEqual([
      expect.closeTo(-0.001, 6),
      expect.closeTo(-0.002, 6),
    ]);
  });
});

describe('Renderer, phase 4', () => {
  // Float index of a member of the fake frame block.
  const frameIndex = (name: string) => {
    let offset = 0;
    for (const member of engineUniformBlocks.frame) {
      if (member.name === name) {
        return offset / 4;
      }
      offset += sizeOf(member.type);
    }
    throw new Error(`no frame member ${name}`);
  };
  // The vec4 of a light in an array of the frame block.
  const lightVec4 = (floats: number[], array: string, light: number) => {
    const index = frameIndex(array) + light * 4;
    return floats.slice(index, index + 4).map((v) => +v.toFixed(4));
  };

  const frameFloats = (log: ReturnType<typeof fakeBackend>['log']) =>
    floatsOf(
      log.buffers.find((b) => b.label?.endsWith('frame uniforms')) as FakeBuffer
    );

  it('writes the lights in the arrays of the frame uniforms', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    const camera = new Camera();
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];

    renderer.render({
      items,
      camera,
      surface,
      lights: [
        new DirectionalLight({
          direction: { x: 0, y: -2, z: 0 },
          ambient: { x: 0.1, y: 0.2, z: 0.3 },
        }),
        new PointLight({
          position: { x: 1, y: 2, z: 3 },
          linearAttenuation: 0.5,
        }),
        new SpotLight({
          position: { x: 0, y: 5, z: 0 },
          direction: { x: 0, y: -3, z: 0 },
          innerCutoff: 0,
          outerCutoff: 60,
        }),
      ],
    });
    const floats = frameFloats(log);
    expect(floats[frameIndex('lightCount')]).toBe(3);
    // Directional: the direction towards the light, w = 0, no attenuation,
    // a cone lighting every direction.
    expect(lightVec4(floats, 'lightPositions', 0)).toEqual([0, 1, 0, 0]);
    expect(lightVec4(floats, 'lightAmbients', 0)).toEqual([0.1, 0.2, 0.3, 0]);
    expect(lightVec4(floats, 'lightAttenuations', 0)).toEqual([1, 0, 0, 0]);
    expect(lightVec4(floats, 'lightSpotCones', 0)).toEqual([-1, -2, 0, 0]);
    // Point: its position, w = 1, its attenuation.
    expect(lightVec4(floats, 'lightPositions', 1)).toEqual([1, 2, 3, 1]);
    expect(lightVec4(floats, 'lightAttenuations', 1)).toEqual([1, 0.5, 0, 0]);
    // Spot: its normalized direction and the cosines of its cone.
    expect(lightVec4(floats, 'lightSpotDirections', 2)).toEqual([0, -1, 0, 0]);
    expect(lightVec4(floats, 'lightSpotCones', 2)).toEqual([1, 0.5, 0, 0]);

    // No light: nothing is summed, lit materials only show their emissive
    // color.
    renderer.render({ items, camera, surface });
    expect(frameFloats(log)[frameIndex('lightCount')]).toBe(0);
  });

  it('uses at most MaxLights lights', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend);
    renderer.render({
      items: [
        {
          mesh: triangle(),
          material: new Material({ graph: colorGraph() }),
          transform: transformAt(0),
        },
      ],
      camera: new Camera(),
      surface,
      lights: Array.from(
        { length: MaxLights + 2 },
        (_, i) => new PointLight({ position: { x: i, y: 0, z: 0 } })
      ),
    });
    const floats = frameFloats(log);
    expect(floats[frameIndex('lightCount')]).toBe(MaxLights);
    expect(lightVec4(floats, 'lightPositions', MaxLights - 1)).toEqual([
      MaxLights - 1,
      0,
      0,
      1,
    ]);
  });

  it('compiles a new variant when a feature changes', () => {
    const { render, log } = setup();
    const g = new GraphBuilder('variants');
    g.parameter('textured', false);
    const textured = g.call(std.textureSample, {
      texture: g.texture('map'),
      sampler: g.sampler('mapSampler'),
      uv: g.attribute('uv', BuiltinTypes.vec2f),
    });
    g.surface({
      baseColor: g.call(
        stdMacros.staticSwitch,
        { ifTrue: textured.swizzle('rgb'), ifFalse: [1, 0, 0] },
        { params: { feature: 'textured' } }
      ),
    });
    const material = new Material({
      graph: g.build(),
      values: { map: {}, mapSampler: {} } as never,
    });
    const items = [{ mesh: triangle(), material, transform: transformAt(0) }];

    render(items);
    render(items);
    expect(log.pipelines).toHaveLength(1);
    expect(log.pipelines[0].program.variantKey).toEqual({
      textured: false,
      alphaMode: 'opaque',
      toneMapping: 'none',
      outputEncoding: 'srgb',
    });

    material.setFeature('textured', true);
    render(items);
    expect(log.pipelines).toHaveLength(2);
    expect(log.pipelines[1].program.variantKey).toEqual({
      textured: true,
      alphaMode: 'opaque',
      toneMapping: 'none',
      outputEncoding: 'srgb',
    });
  });

  it('skips items until their asynchronous pipeline is ready', async () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend, { asyncPipelines: true });
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    const camera = new Camera();

    renderer.render({ items, camera, surface });
    expect(log.draws).toHaveLength(0);
    expect(log.submits).toBe(1);

    await renderer.whenReady();
    renderer.render({ items, camera, surface });
    expect(log.draws).toHaveLength(1);
    expect(log.pipelines).toHaveLength(1);
  });
});

describe('Material', () => {
  it('falls back on the defaults of the graph', () => {
    const material = new Material({ graph: colorGraph() });
    expect(material.getValue('color')).toEqual([1, 0, 0]);
    material.setValue('color', [0, 1, 0]);
    expect(material.getValue('color')).toEqual([0, 1, 0]);
    expect(material.version).toBe(1);
  });

  it('disables depth writes of transparent materials by default', () => {
    const material = (renderState: Partial<RenderState>) =>
      new Material({ graph: colorGraph(), renderState }).renderState.depthWrite;
    expect(material({})).toBe(true);
    expect(material({ alphaMode: 'blend' })).toBe(false);
    expect(material({ alphaMode: 'blend', depthWrite: true })).toBe(true);
  });
});

describe('Mesh', () => {
  it('checks the data against the description', () => {
    const description = triangle().description;
    expect(() => new Mesh({ description, vertices: [] })).toThrow(
      /describes 1 vertex buffers but 0/
    );
    expect(
      () => new Mesh({ description, vertices: [new Float32Array(15)] })
    ).toThrow(/no indices were given/);
    expect(
      () =>
        new Mesh({
          description,
          vertices: [new Float32Array(15)],
          indices: new Uint32Array([0, 1, 2]),
        })
    ).toThrow(/must be a Uint16Array/);
  });

  it('versions vertex updates', () => {
    const mesh = triangle();
    mesh.setVertices(0, new Float32Array(15));
    expect(mesh.version).toBe(1);
    expect(() => mesh.setVertices(1, new Float32Array(1))).toThrow(
      /no vertex buffer 1/
    );
  });
});

describe('Renderer, multisampling', () => {
  it('draws into multisampled attachments resolved into the target', () => {
    const { backend, log } = fakeBackend();
    const renderer = new Renderer(backend, { samples: 4 });
    const items = [
      {
        mesh: triangle(),
        material: new Material({ graph: colorGraph() }),
        transform: transformAt(0),
      },
    ];
    renderer.render({ items, camera: new Camera(), surface });
    expect(log.renderPasses).toEqual(['scene opaque']);
    expect(
      log.textures.map(({ label, format, sampleCount }) => [
        label,
        format,
        sampleCount,
      ])
    ).toEqual([
      ['scene multisampled color', 'rgba8unorm', 4],
      ['scene depth', 'depth24plus', 4],
    ]);
    expect(log.pipelines[0].sampleCount).toBe(4);

    // With transparent items, the second pass resolves.
    const glass = new Material({
      graph: colorGraph(),
      renderState: { alphaMode: 'blend' },
    });
    const graph = new RenderGraph();
    const target = graph.importTexture('surface', surface.getCurrentTarget());
    renderer.addScenePasses(graph, {
      items: [...items, { ...items[0], material: glass }],
      camera: new Camera(),
      target,
      format: surface.format,
    });
    const compiled = graph.compile();
    expect(compiled.order.map((index) => graph.passes[index].name)).toEqual([
      'scene opaque',
      'scene transparent',
    ]);
    expect(graph.toDot()).toContain('p1 -> r0v1 [label="color-attachment"];');
  });
});

// What reaches the pass encoder: the state already bound by the previous
// draw must not be sent again.
describe('Renderer, state bound on the pass', () => {
  const shared = (count: number, mesh: Mesh, material: Material) =>
    Array.from({ length: count }, (_, i) => ({
      mesh,
      material,
      transform: transformAt(i),
    }));

  it('binds the pipeline, frame, material and mesh once for items sharing them', () => {
    const { render, log } = setup();
    const count = 5;
    render(shared(count, triangle(), new Material({ graph: colorGraph() })));

    // One draw of every instance: each group, the object table included,
    // bound once.
    const groups = Object.keys(log.draws[0].groups).length;
    expect(log.draws).toHaveLength(1);
    expect(log.draws[0].instances).toBe(count);
    expect(log.calls).toEqual({
      setPipeline: 1,
      setBindGroup: groups,
      setVertexBuffer: 1,
      setIndexBuffer: 1,
    });
  });

  it('still gives every draw its complete state', () => {
    const { render, log } = setup();
    const count = 4;
    const material = new Material({ graph: colorGraph() });
    // A mesh each: a draw each.
    render(
      Array.from({ length: count }, (_, i) => ({
        mesh: triangle(),
        material,
        transform: transformAt(i),
      }))
    );

    const [first] = log.draws;
    expect(log.draws).toHaveLength(count);
    for (const draw of log.draws) {
      expect(Object.keys(draw.groups)).toEqual(Object.keys(first.groups));
      // The frame, material and object table groups are the same objects
      // for all the draws.
      expect(draw.groups[0]).toBe(first.groups[0]);
      expect(draw.groups[1]).toBe(first.groups[1]);
      expect(draw.groups[2]).toBe(first.groups[2]);
    }
  });

  it('binds the groups again after a change of pipeline', () => {
    const { render, log } = setup();
    const mesh = triangle();
    const transform = transformAt(0);
    render([
      { mesh, material: new Material({ graph: colorGraph() }), transform },
      {
        mesh,
        material: new Material({
          graph: colorGraph(),
          renderState: { doubleSided: true },
        }),
        transform,
      },
    ]);

    // Another pipeline can have other layouts: even the frame and object
    // groups, the same objects in both draws, are bound again.
    const groups = Object.keys(log.draws[0].groups).length;
    expect(log.pipelines).toHaveLength(2);
    expect(log.calls.setPipeline).toBe(2);
    expect(log.calls.setBindGroup).toBe(2 * groups);
    expect(Object.keys(log.draws[1].groups)).toHaveLength(groups);
  });

  it('binds the vertex and index buffers again when the mesh changes', () => {
    const { render, log } = setup();
    const material = new Material({ graph: colorGraph() });
    render([
      ...shared(2, triangle(), material),
      ...shared(2, triangle(), material),
    ]);

    // A draw of two instances per mesh.
    const groups = Object.keys(log.draws[0].groups).length;
    expect(log.draws.map((draw) => draw.instances)).toEqual([2, 2]);
    expect(log.calls.setPipeline).toBe(1);
    expect(log.calls.setVertexBuffer).toBe(2);
    expect(log.calls.setIndexBuffer).toBe(2);
    expect(log.calls.setBindGroup).toBe(groups);
  });

  it('does not carry the bound state from a frame to the next', () => {
    const { render, log } = setup();
    const items = shared(3, triangle(), new Material({ graph: colorGraph() }));
    render(items);
    render(items);

    // Each frame has its own pass encoder: everything is bound again.
    expect(log.draws).toHaveLength(2);
    expect(log.calls.setPipeline).toBe(2);
    expect(log.calls.setVertexBuffer).toBe(2);
    expect(Object.keys(log.draws[1].groups)).toEqual(
      Object.keys(log.draws[0].groups)
    );
  });
});
