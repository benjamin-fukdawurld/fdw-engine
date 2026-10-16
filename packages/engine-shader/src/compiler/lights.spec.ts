import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std, stdLights } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint, IrInstruction } from './ir';

const fragmentOf = (graph: ReturnType<GraphBuilder['build']>) =>
  compile(graph).module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment',
  ) as IrEntryPoint;

const loops = (body: readonly IrInstruction[]) =>
  body.filter((instruction) => instruction.op.kind === 'loop-sum');

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
    // Only the outputs of light.current in use are read.
    const members = op.body
      .filter((i) => i.op.kind === 'load-resource')
      .map((i) => (i.op as { member?: string }).member);
    expect(members).toEqual(['lightDiffuses']);
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
});
