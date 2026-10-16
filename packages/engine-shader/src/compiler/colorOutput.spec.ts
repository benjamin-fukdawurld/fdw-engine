import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../graph/GraphBuilder';
import { BuiltinTypes } from '../types/ShaderType';
import { compile } from './compile';
import { forEachInstruction, IrEntryPoint, IrInstruction } from './ir';

const graph = () => {
  const g = new GraphBuilder('colored');
  g.surface({ baseColor: g.uniform('color', BuiltinTypes.vec3f) });
  return g.build();
};

const fragmentInstructions = (program: ReturnType<typeof compile>) => {
  const fragment = program.module.entryPoints.find(
    (entryPoint) => entryPoint.stage === 'fragment',
  ) as IrEntryPoint;
  const all: IrInstruction[] = [];
  forEachInstruction(fragment.body, (instruction) => all.push(instruction));
  return all;
};

const members = (instructions: IrInstruction[]) =>
  instructions
    .filter((i) => i.op.kind === 'load-resource')
    .map((i) => (i.op as { member?: string }).member);

describe('color output', () => {
  it('writes the color as is without output features', () => {
    const instructions = fragmentInstructions(compile(graph()));
    expect(instructions.some((i) => i.op.kind === 'intrinsic')).toBe(false);
    expect(members(instructions)).not.toContain('exposure');
  });

  it('encodes the color in sRGB', () => {
    const program = compile(graph(), {
      features: { outputEncoding: 'srgb' },
    });
    const constants = fragmentInstructions(program)
      .filter((i) => i.op.kind === 'constant')
      .map((i) => (i.op as { value: unknown }).value);
    // pow(c, 1 / 2.4), splatted to the vec3 of the color.
    expect(
      constants.some(
        (value) =>
          Array.isArray(value) &&
          value.length === 3 &&
          value.every((component) => Math.abs(component - 1 / 2.4) < 1e-6),
      ),
    ).toBe(true);
    expect(program.variantKey).toEqual({ outputEncoding: 'srgb' });
  });

  it('tone maps the color multiplied by the exposure', () => {
    for (const toneMapping of ['reinhard', 'aces', 'neutral']) {
      const program = compile(graph(), { features: { toneMapping } });
      expect(members(fragmentInstructions(program))).toContain('exposure');
    }
  });

  it('rejects unknown tone mappings', () => {
    expect(() =>
      compile(graph(), { features: { toneMapping: 'magic' } }),
    ).toThrow(/unknown tone mapping "magic"/);
  });

  it('gives a program per output', () => {
    const keys = new Set(
      (
        [
          {},
          { outputEncoding: 'srgb' },
          { toneMapping: 'aces' },
          { toneMapping: 'aces', outputEncoding: 'srgb' },
        ] as Record<string, string>[]
      ).map((features) => compile(graph(), { features }).programKey),
    );
    expect(keys.size).toBe(4);
  });
});
