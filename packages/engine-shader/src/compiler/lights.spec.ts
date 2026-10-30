import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std, stdLights } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { lightMembers } from './layout';
import type { IrEntryPoint, IrInstruction } from './ir';

const fragmentOf = (graph: ReturnType<GraphBuilder['build']>) =>
  compile(graph).module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment',
  ) as IrEntryPoint;

const loops = (body: readonly IrInstruction[]) =>
  body.filter((instruction) => instruction.op.kind === 'loop-sum');

// The vec4 of the light read in a loop body: their offsets in the record
// of the light in the pool (see lightMembers).
function poolOffsets(body: readonly IrInstruction[]): number[] {
  const byId = new Map(body.map((i) => [i.id, i]));
  const pool = body.find(
    (i) => i.op.kind === 'load-resource' && i.op.binding === 'lights',
  );
  return body
    .filter((i) => i.op.kind === 'index' && i.args[0] === pool?.id)
    .map((i) => {
      const at = byId.get(i.args[1]);
      if (at?.op.kind !== 'binary' || at.op.operator !== '+') {
        return 0;
      }
      const offset = byId.get(at.args[1]);
      return offset?.op.kind === 'constant' ? (offset.op.value as number) : -1;
    });
}

describe('light loops', () => {
  it('sums a custom per-light value', () => {
    const g = new GraphBuilder('diffuse-only');
    const light = g.node(stdLights.current);
    const tint = g.uniform('tint', BuiltinTypes.vec3f);
    g.surface({
      baseColor: g.call(stdLights.sum, {
        value: g.call(std.mul, { a: light.diffuse, b: tint }),
      }),
    });
    const fragment = fragmentOf(g.build());
    const [loop] = loops(fragment.body);
    const op = loop?.op;
    if (op?.kind !== 'loop-sum') {
      throw new Error('expected a loop');
    }
    expect(loop.type).toEqual(BuiltinTypes.vec3f);
    // The tint does not depend on the light: read once, before the loop.
    const tintLoad = fragment.body.find(
      (i) => i.op.kind === 'load-resource' && i.op.member === 'tint',
    );
    expect(tintLoad).toBeDefined();
    // Only the outputs of light.current in use are read: the diffuse
    // color, the third vec4 of the light in the pool.
    expect(poolOffsets(op.body)).toEqual([lightMembers['diffuse'].offset]);
    // The body ends with the summed value, which reads the tint.
    const result = op.body.find((i) => i.id === op.result);
    expect(result?.args).toContain(tintLoad?.id);
  });

  it('builds one loop per light.sum', () => {
    const g = new GraphBuilder('two-sums');
    const light = g.node(stdLights.current);
    g.surface({
      baseColor: g.call(std.add, {
        a: g.call(stdLights.sum, { value: light.ambient }),
        b: g.call(stdLights.sum, { value: light.diffuse }),
      }),
    });
    expect(loops(fragmentOf(g.build()).body)).toHaveLength(2);
  });

  it('rejects per-light values used outside a light.sum', () => {
    const g = new GraphBuilder('no-sum');
    const light = g.node(stdLights.current);
    g.surface({ baseColor: light.diffuse });
    expect(() => compile(g.build())).toThrow(GraphError);
    expect(() => compile(g.build())).toThrow(/light\.sum/);
  });

  it('keeps the loop out of the vertex stage', () => {
    const g = new GraphBuilder('vertex-light');
    const light = g.node(stdLights.current);
    g.surface({
      positionOffset: g.call(stdLights.sum, { value: light.diffuse }),
    });
    expect(() => compile(g.build())).toThrow(/fragment stage/);
  });

  it('reads the lights from the light pool, without limit', () => {
    const g = new GraphBuilder('pool');
    const light = g.node(stdLights.current);
    g.surface({
      baseColor: g.call(stdLights.sum, { value: light.diffuse }),
    });
    const program = compile(g.build());
    const frame = program.layout.groups.find((group) => group.slot === 'frame');
    expect(frame?.bindings.map((binding) => binding.name)).toEqual([
      'frameUniforms',
      'lights',
    ]);
    expect(frame?.bindings[1]).toMatchObject({
      kind: 'storage-buffer',
      access: 'read',
    });
    // Without position nor clusters: every light of the pool.
    const fragment = fragmentOf(g.build());
    const [loop] = loops(fragment.body);
    const count = fragment.body.find((i) => i.id === loop.args[0]);
    expect(count?.op).toMatchObject({ member: 'lightCount' });
  });

  describe('clusters', () => {
    const clustered = (features = { lightClusters: true }) => {
      const g = new GraphBuilder('clustered');
      const light = g.node(stdLights.current);
      const position = g.call(std.perFragment, {
        value: g.attribute('position', BuiltinTypes.vec3f),
      });
      g.surface({
        baseColor: g.call(stdLights.sum, {
          value: g.call(std.mul, { a: light.diffuse, b: light.attenuation }),
          position,
        }),
      });
      return compile(g.build(), { features });
    };
    const frameBindings = (program: ReturnType<typeof compile>) =>
      program.layout.groups
        .find((group) => group.slot === 'frame')
        ?.bindings.map((binding) => binding.name);

    it('sum the global lights, then those of the cluster of the point', () => {
      const program = clustered();
      expect(program.variantKey).toMatchObject({ lightClusters: true });
      expect(frameBindings(program)).toEqual([
        'frameUniforms',
        'lights',
        'lightGrid',
      ]);
      const fragment = program.module.entryPoints.find(
        (entryPoint) => entryPoint.stage === 'fragment',
      ) as IrEntryPoint;
      const [loop] = loops(fragment.body);
      const op = loop.op;
      if (op.kind !== 'loop-sum') {
        throw new Error('expected a loop');
      }
      // The count: the global lights and those of the list.
      const count = fragment.body.find((i) => i.id === loop.args[0]);
      expect(count?.op).toEqual({ kind: 'binary', operator: '+' });
      // The light: the index for the global ones, from the list otherwise.
      expect(op.body.filter((i) => i.op.kind === 'select')).toHaveLength(2);
      const grids = new Set(
        fragment.body
          .filter(
            (i) =>
              i.op.kind === 'load-resource' && i.op.binding === 'lightGrid',
          )
          .map((i) => i.id),
      );
      expect(
        op.body.some((i) => i.op.kind === 'index' && grids.has(i.args[0])),
      ).toBe(true);
      expect(poolOffsets(op.body).sort()).toEqual([
        lightMembers['diffuse'].offset,
        lightMembers['attenuation'].offset,
      ]);
      // The cluster: from the view depth (log2) and the clip position.
      const members = fragment.body
        .filter((i) => i.op.kind === 'load-resource')
        .map((i) => (i.op as { member?: string }).member);
      expect(members).toEqual(
        expect.arrayContaining([
          'lightClusters',
          'lightClusterDepth',
          'view',
          'viewProjection',
        ]),
      );
      expect(
        fragment.body.some(
          (i) => i.op.kind === 'intrinsic' && i.op.name === 'log2',
        ),
      ).toBe(true);
    });

    it('are left out without the feature', () => {
      expect(frameBindings(clustered({ lightClusters: false }))).toEqual([
        'frameUniforms',
        'lights',
      ]);
    });

    it('refuse derivatives in their loop, whose count changes from pixel to pixel', () => {
      const g = new GraphBuilder('cookie');
      const light = g.node(stdLights.current);
      g.surface({
        baseColor: g.call(stdLights.sum, {
          value: g
            .call(std.textureSample, {
              texture: g.texture('cookie'),
              sampler: g.sampler('cookieSampler'),
              uv: light.position.swizzle('xy'),
            })
            .swizzle('rgb'),
          position: g.call(std.perFragment, {
            value: g.attribute('position', BuiltinTypes.vec3f),
          }),
        }),
      });
      const implicit = g.build();
      expect(() =>
        compile(implicit, { features: { lightClusters: true } }),
      ).toThrow(/std\.textureSample computes derivatives/);
      // Without clusters, every pixel loops over the same lights.
      expect(() => compile(implicit)).not.toThrow();
    });

    it('are used by the lit shading models', () => {
      for (const shadingModel of ['phong', 'pbr']) {
        const g = new GraphBuilder('lit');
        g.surface({ shadingModel, baseColor: [1, 1, 1] });
        const program = compile(g.build(), {
          vertexAttributes: ['position', 'normal'],
          features: { lightClusters: true },
        });
        expect(frameBindings(program)).toContain('lightGrid');
      }
    });
  });
});
