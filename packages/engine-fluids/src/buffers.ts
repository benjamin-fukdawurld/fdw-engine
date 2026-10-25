import type {
  GpuBuffer,
  GpuComputePassEncoder,
  RenderBackend,
} from '@fdw/engine-backend';
import type { ComputeRunner, MaterialValue } from '@fdw/engine-core';
import { compile } from '@fdw/engine-shader';
import type {
  CompiledProgram,
  ConstantValue,
  MaterialGraphData,
} from '@fdw/engine-shader';

/** Writes floats (or words) at the start of a buffer, or at `offset` bytes. */
export function writeData(
  buffer: GpuBuffer,
  data: Float32Array | Uint32Array,
  offset = 0,
): void {
  buffer.write(
    offset,
    data.buffer as ArrayBuffer,
    data.byteOffset,
    data.byteLength,
  );
}

/** A compiled compute graph, and the defaults of its uniforms. */
export interface FluidProgram {
  readonly program: CompiledProgram;
  readonly defaults: Readonly<Record<string, ConstantValue>>;
}

/**
 * Compiles a compute graph with the defaults of its uniforms: a dispatch
 * gives the values it sets, the defaults the others (the runner of the
 * compute graphs leaves them at 0).
 */
export function compileFluid(
  graph: MaterialGraphData,
  capabilities: RenderBackend['capabilities'],
): FluidProgram {
  const defaults: Record<string, ConstantValue> = {};
  for (const node of graph.nodes) {
    const value = node.params['default'];
    if (node.type === 'input.uniform' && value !== undefined) {
      defaults[node.params['name'] as string] = value as ConstantValue;
    }
  }
  return { program: compile(graph, { capabilities }), defaults };
}

/** Records a dispatch of a program, its defaults under the values given. */
export function recordFluid(
  runner: ComputeRunner,
  pass: GpuComputePassEncoder,
  fluid: FluidProgram,
  values: Readonly<Record<string, MaterialValue>>,
  workgroups: readonly [number, number?, number?],
): void {
  runner.record(pass, fluid.program, {
    values: { ...fluid.defaults, ...values },
    workgroups,
  });
}
