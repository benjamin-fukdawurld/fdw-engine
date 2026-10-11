import {
  PhysicalProgramLayout,
  RenderBackend,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import type { CompiledProgram } from '@fdw/engine-shader';
import {
  compileHlsl,
  findTool,
  HlslCodegen,
  reflectUniformBlocks,
  validateSpirv,
} from '@fdw/engine-vulkan';
import { describe, expect, it } from 'vitest';
import { createDawnFixture, dawn } from './dawnFixture';
import { describeRenderer } from './suite';
import { canRun } from '@fdw/engine-backend/testing';

// Every program of the rendering suite in HLSL: the suite runs on Dawn
// while recording the programs of the pipelines it creates; each one is
// then generated in HLSL, compiled to SPIR-V by DXC, validated by
// spirv-val, and its uniform blocks reflected against the layout of the
// Vulkan backend. Needs Dawn and the Vulkan SDK (dxc, spirv-val,
// spirv-cross).

const sdk = !!(
  findTool('dxc') &&
  findTool('spirv-val') &&
  findTool('spirv-cross')
);
const skip = !canRun(
  'hlsl',
  !!dawn && sdk,
  'needs Dawn and the Vulkan SDK (dxc, spirv-val, spirv-cross)'
);

const programs = new Map<string, CompiledProgram>();

// Records the programs of the pipelines created by the backend.
function recordPrograms(backend: RenderBackend): void {
  const pipelines = backend.pipelines;
  const record =
    <D extends { program: CompiledProgram }, R>(create: (descriptor: D) => R) =>
    (descriptor: D): R => {
      programs.set(descriptor.program.programKey, descriptor.program);
      return create.call(pipelines, descriptor);
    };
  pipelines.createRenderPipeline = record(pipelines.createRenderPipeline);
  pipelines.createRenderPipelineAsync = record(
    pipelines.createRenderPipelineAsync
  );
  pipelines.createComputePipeline = record(pipelines.createComputePipeline);
  pipelines.createComputePipelineAsync = record(
    pipelines.createComputePipelineAsync
  );
}

describeRenderer(
  'Rendering suite on Dawn, recording its programs',
  () => createDawnFixture(recordPrograms),
  { skip }
);

// The offsets of the uniform blocks of a module are those of the layout.
async function expectLayout(
  spirv: Uint8Array,
  layout: PhysicalProgramLayout,
  name: string
): Promise<void> {
  const reflected = [...(await reflectUniformBlocks(spirv)).values()];
  for (const group of layout.groups) {
    for (const { binding, block, resource } of group.bindings) {
      const found = reflected.find(
        (candidate) =>
          candidate.set === group.index && candidate.binding === binding
      );
      if (!block || !found) {
        continue;
      }
      expect(
        found.members.map((member) => member.offset),
        `${name}: ${resource.name}`
      ).toEqual(block.members.map((member) => member.offset));
    }
  }
}

describe.skipIf(skip)('The programs of the rendering suite in HLSL', () => {
  it('compile to valid SPIR-V, with the offsets of the layout', async () => {
    // Surfaces, raw stages, full screen passes, compute kernels, shadows…
    expect(programs.size).toBeGreaterThan(30);
    const codegen = new HlslCodegen();
    const failures: string[] = [];
    for (const program of programs.values()) {
      const layout = std140LayoutStrategy.resolve(program.layout);
      try {
        const modules = await compileHlsl(codegen.emit(program.module, layout));
        for (const spirv of modules.values()) {
          await validateSpirv(spirv);
          await expectLayout(spirv, layout, program.name);
        }
      } catch (error) {
        failures.push(`${program.name}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
