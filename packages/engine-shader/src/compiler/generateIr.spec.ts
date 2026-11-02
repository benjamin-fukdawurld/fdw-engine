import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../graph/Diagnostic';
import { GraphBuilder } from '../graph/GraphBuilder';
import type { MaterialGraphData } from '../graph/MaterialGraphData';
import { validateGraph } from '../graph/validateGraph';
import { createStandardRegistry, std } from '../std';
import { arrayType, BuiltinTypes } from '../types/ShaderType';
import { generateComputeIr, generateIr } from './generateIr';
import type { IrEntryPoint, IrInstruction } from './ir';
import { analyzeLoops } from './loops';
import { planStages } from './stages';
import { WorkingGraph } from './WorkingGraph';

const registry = createStandardRegistry();

// The passes of compile() that generateIr needs, without the lowerings and
// the optimizations: the IR of the graph as written.
const prepare = (graph: MaterialGraphData) => {
  const working = new WorkingGraph(graph);
  const validation = validateGraph(working.toData(), registry);
  expect(validation.diagnostics).toEqual([]);
  const diagnostics: Diagnostic[] = [];
  const loops = analyzeLoops(working, validation.types, diagnostics);
  expect(diagnostics).toEqual([]);
  return { working, validation, loops, diagnostics };
};

const toIr = (graph: MaterialGraphData) => {
  const { working, validation, loops, diagnostics } = prepare(graph);
  const plan = planStages({
    graph: working,
    nodes: validation.nodes,
    order: validation.order,
    types: validation.types,
    maxVaryings: 8,
    diagnostics,
    loops,
  });
  expect(plan).toBeDefined();
  return generateIr({
    graph: working,
    nodes: validation.nodes,
    order: validation.order,
    types: validation.types,
    plan: plan as NonNullable<typeof plan>,
    loops,
  });
};

const entryPoint = (
  module: ReturnType<typeof generateIr>,
  stage: IrEntryPoint['stage'],
) =>
  module.entryPoints.find(
    (candidate) => candidate.stage === stage,
  ) as IrEntryPoint;

const byId = (entry: IrEntryPoint, id: number | undefined) =>
  entry.body.find((instruction) => instruction.id === id) as IrInstruction;

// Every argument is defined before it is read, and every value once.
const expectWellFormed = (entry: IrEntryPoint) => {
  const defined = new Set<number>();
  for (const instruction of entry.body) {
    for (const arg of instruction.args) {
      expect(defined.has(arg)).toBe(true);
    }
    expect(defined.has(instruction.id)).toBe(false);
    defined.add(instruction.id);
  }
};

// position → clip position in the vertex stage; color = uv + fragCoord ×
// tint in the fragment stage, where fragCoord only exists.
const twoStages = () => {
  const g = new GraphBuilder('two-stages', registry);
  const position = g.attribute('position', BuiltinTypes.vec3f);
  g.node('output.vertex', {
    inputs: {
      clipPosition: g.call(std.extend, { xyz: position, w: 1 }),
    },
  });
  const uv = g.attribute('uv', BuiltinTypes.vec2f);
  const tint = g.uniform('tint', BuiltinTypes.f32);
  const shaded = g.call(
    std.mul,
    { a: g.builtin('frag-coord').swizzle('xy'), b: tint },
    { label: 'shaded uv' },
  );
  const color = g.call(std.add, { a: uv, b: shaded });
  g.node('output.fragment', {
    inputs: {
      color: g.call(std.extend, { xyz: color.swizzle('xyy'), w: 1 }),
    },
  });
  return g.build();
};

describe('generateIr', () => {
  it('produces a vertex and a fragment entry point', () => {
    const module = toIr(twoStages());
    expect(module.name).toBe('two-stages');
    expect(module.entryPoints.map((entry) => entry.stage)).toEqual([
      'vertex',
      'fragment',
    ]);
    for (const entry of module.entryPoints) {
      expectWellFormed(entry);
    }
  });

  it('reads the attributes in the vertex stage only', () => {
    const module = toIr(twoStages());
    const vertex = entryPoint(module, 'vertex');
    expect(vertex.inputs.map((input) => input.type)).toEqual(
      expect.arrayContaining([BuiltinTypes.vec3f, BuiltinTypes.vec2f]),
    );
    expect(vertex.outputs[0]).toEqual(
      expect.objectContaining({ name: 'clipPosition', builtin: 'position' }),
    );
    const clip = byId(vertex, vertex.results['clipPosition']);
    expect(clip.type).toEqual(BuiltinTypes.vec4f);
  });

  it('passes the vertex values to the fragment stage as varyings', () => {
    const module = toIr(twoStages());
    const vertex = entryPoint(module, 'vertex');
    const fragment = entryPoint(module, 'fragment');
    const varyings = fragment.inputs.filter((input) => !input.builtin);
    expect(varyings).toHaveLength(1);
    expect(varyings[0].type).toEqual(BuiltinTypes.vec2f);
    expect(vertex.outputs.map((output) => output.name)).toContain(
      varyings[0].name,
    );
    expect(
      fragment.body.some(
        (instruction) =>
          instruction.op.kind === 'load-input' &&
          instruction.op.input === varyings[0].name,
      ),
    ).toBe(true);
  });

  it('computes the fragment values in the fragment stage, with their label', () => {
    const fragment = entryPoint(toIr(twoStages()), 'fragment');
    const product = fragment.body.find(
      (instruction) =>
        instruction.op.kind === 'binary' && instruction.op.operator === '*',
    ) as IrInstruction;
    expect(product.op).toEqual({ kind: 'binary', operator: '*' });
    expect(product.name).toBe('shaded uv');
    expect(product.type).toEqual(BuiltinTypes.vec2f);
    expect(
      fragment.body.some(
        (instruction) =>
          instruction.op.kind === 'load-resource' &&
          instruction.op.member === 'tint',
      ),
    ).toBe(true);
    expect(byId(fragment, fragment.results['color']).type).toEqual(
      BuiltinTypes.vec4f,
    );
  });
});

describe('generateComputeIr', () => {
  it('turns the write.storage nodes into the writes of the stage', () => {
    const g = new GraphBuilder('fill', registry);
    const index = g.builtin('global-invocation-id').swizzle('x');
    const output = g.storage('output', arrayType(BuiltinTypes.f32), {
      access: 'read-write',
    });
    g.write(output, { index, value: 2 });
    g.compute({ workgroupSize: [8, 4, 1] });
    const { working, validation, loops } = prepare(g.build());
    const module = generateComputeIr({
      graph: working,
      nodes: validation.nodes,
      order: validation.order,
      types: validation.types,
      loops,
    });
    expect(module.entryPoints).toHaveLength(1);
    const [compute] = module.entryPoints;
    expectWellFormed(compute);
    expect(compute.stage).toBe('compute');
    expect(compute.workgroupSize).toEqual([8, 4, 1]);
    expect(compute.inputs).toEqual([]);
    expect(compute.writes).toHaveLength(1);
    const [write] = compute.writes ?? [];
    expect(write.resource).toBe('output');
    expect(write.condition).toBeUndefined();
    expect(byId(compute, write.value).op).toEqual({
      kind: 'constant',
      value: 2,
    });
  });
});
