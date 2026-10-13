import { describe, expect, it } from 'vitest';
import { GraphError } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import { std } from '../std';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import type { IrEntryPoint } from './ir';

const fragmentOf = (program: ReturnType<typeof compile>) =>
  program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment'
  ) as IrEntryPoint;

// A full screen pass writing a color, a vector and an integer.
const threeTargets = () => {
  const g = new GraphBuilder('three targets');
  const uv = g.builtin('screen-uv');
  g.fullscreen({ color: [1, 0, 0, 1] });
  g.target('uv', uv, 1);
  g.target('id', g.constant(BuiltinTypes.u32, 7), 2);
  return g.build();
};

describe('output.target', () => {
  it('adds color targets to the fragment stage, by location', () => {
    const fragment = fragmentOf(compile(threeTargets()));
    expect(
      fragment.outputs.map(({ name, type, location }) => [name, type, location])
    ).toEqual([
      ['color', BuiltinTypes.vec4f, 0],
      ['uv', BuiltinTypes.vec2f, 1],
      ['id', BuiltinTypes.u32, 2],
    ]);
    expect(Object.keys(fragment.results).sort()).toEqual(['color', 'id', 'uv']);
  });

  it('writes targets without color, from location 0', () => {
    const g = new GraphBuilder('normals only');
    g.node('output.vertex', { inputs: { clipPosition: [0, 0, 0, 1] } });
    g.node('output.fragment', {});
    g.target('normal', [0, 0, 1, 0], 0);
    const fragment = fragmentOf(compile(g.build()));
    expect(fragment.outputs.map((output) => output.name)).toEqual(['normal']);
  });

  it('changes the key of the program', () => {
    const g = new GraphBuilder('three targets');
    g.fullscreen({ color: [1, 0, 0, 1] });
    expect(compile(g.build()).programKey).not.toBe(
      compile(threeTargets()).programKey
    );
  });

  it('refuses taken locations, taken names and unsupported types', () => {
    const errors = (build: (g: GraphBuilder) => void) => {
      const g = new GraphBuilder('wrong');
      g.fullscreen({ color: [1, 1, 1, 1] });
      build(g);
      try {
        compile(g.build());
      } catch (error) {
        return (error as GraphError).diagnostics.map((d) => d.message);
      }
      return [];
    };
    expect(errors((g) => g.target('normal', [0, 0, 1, 0], 0))).toEqual([
      'location 0 is already written by "color"',
    ]);
    expect(
      errors((g) => {
        g.target('a', 1, 1);
        g.target('b', 2, 1);
      })
    ).toEqual(['location 1 is already written by "a"']);
    expect(errors((g) => g.target('color', 1, 1))).toEqual([
      'the fragment already has an output named "color"',
    ]);
    expect(errors((g) => g.target('far', 1, 8))).toEqual([
      'invalid target location 8: from 0 to 7',
    ]);
    // Booleans have no target format: refused as the graph is built.
    const g = new GraphBuilder('boolean');
    expect(() =>
      g.target('flag', g.call(std.greater, { a: 1, b: 0 }), 1)
    ).toThrow(/does not satisfy the constraint "numeric"/);
  });

  it('only goes with the raw stages or a full screen pass', () => {
    const g = new GraphBuilder('surface');
    g.surface({ baseColor: [1, 1, 1] });
    expect(() => {
      g.target('normal', [0, 0, 1, 0], 1);
      g.build();
    }).toThrow(/output.target nodes belong to graphs ending with/);
  });
});
