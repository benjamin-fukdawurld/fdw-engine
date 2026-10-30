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
import { GlslEsCodegen } from '@fdw/engine-webgl2';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createDawnFixture, dawn } from './dawnFixture';
import { describeRenderer } from './suite';
import { canRun } from '@fdw/engine-backend/testing';

// Every program of the rendering suite in the other shading languages: the
// suite runs on Dawn (which validates the WGSL) while recording the
// programs of the pipelines it creates; each one is then generated
// - in HLSL, compiled to SPIR-V by DXC, validated by spirv-val, and its
//   uniform blocks reflected against the layout of the Vulkan backend;
// - in GLSL ES 3.00 (WebGL2), validated and linked by glslangValidator,
//   stricter than the compilers of the browsers: the compute stages as the
//   draws that emulate them.
// Needs Dawn and the Vulkan SDK (dxc, spirv-val, spirv-cross,
// glslangValidator).

// glslangValidator, in the Vulkan SDK or the PATH.
const glslang = [
  ...(process.env['VULKAN_SDK']
    ? [join(process.env['VULKAN_SDK'], 'bin')]
    : []),
  ...(process.env['PATH'] ?? '').split(delimiter),
]
  .map((dir) =>
    join(
      dir,
      process.platform === 'win32'
        ? 'glslangValidator.exe'
        : 'glslangValidator',
    ),
  )
  .find((path) => existsSync(path));

const sdk = !!(
  findTool('dxc') &&
  findTool('spirv-val') &&
  findTool('spirv-cross')
);
const skipHlsl = !canRun(
  'hlsl',
  !!dawn && sdk,
  'needs Dawn and the Vulkan SDK (dxc, spirv-val, spirv-cross)',
);
const skipGlsl = !canRun(
  'glsl',
  !!dawn && !!glslang,
  'needs Dawn and glslangValidator (Vulkan SDK)',
);
const skip = skipHlsl && skipGlsl;

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
    pipelines.createRenderPipelineAsync,
  );
  pipelines.createComputePipeline = record(pipelines.createComputePipeline);
  pipelines.createComputePipelineAsync = record(
    pipelines.createComputePipelineAsync,
  );
}

describeRenderer(
  'Rendering suite on Dawn, recording its programs',
  () => createDawnFixture(recordPrograms),
  { skip },
);

// The offsets of the uniform blocks of a module are those of the layout.
async function expectLayout(
  spirv: Uint8Array,
  layout: PhysicalProgramLayout,
  name: string,
): Promise<void> {
  const reflected = [...(await reflectUniformBlocks(spirv)).values()];
  for (const group of layout.groups) {
    for (const { binding, block, resource } of group.bindings) {
      const found = reflected.find(
        (candidate) =>
          candidate.set === group.index && candidate.binding === binding,
      );
      if (!block || !found) {
        continue;
      }
      expect(
        found.members.map((member) => member.offset),
        `${name}: ${resource.name}`,
      ).toEqual(block.members.map((member) => member.offset));
    }
  }
}

describe.skipIf(skipHlsl)('The programs of the rendering suite in HLSL', () => {
  it(
    'compile to valid SPIR-V, with the offsets of the layout',
    { timeout: 30_000 },
    async () => {
      // Surfaces, raw stages, full screen passes, compute kernels, shadows…
      expect(programs.size).toBeGreaterThan(30);
      const codegen = new HlslCodegen();
      const failures: string[] = [];
      for (const program of programs.values()) {
        const layout = std140LayoutStrategy.resolve(program.layout);
        try {
          const modules = await compileHlsl(
            codegen.emit(program.module, layout),
          );
          for (const spirv of modules.values()) {
            await validateSpirv(spirv);
            await expectLayout(spirv, layout, program.name);
          }
        } catch (error) {
          failures.push(`${program.name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
      // One DXC run per program, one after the other.
    },
  );
});

// Validates and links the two stages of a GLSL ES program.
async function validateGlsl(vertex: string, fragment: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fdw-glsl-'));
  try {
    const files = [join(dir, 'program.vert'), join(dir, 'program.frag')];
    await writeFile(files[0], vertex);
    await writeFile(files[1], fragment);
    await promisify(execFile)(glslang as string, ['-l', ...files]).catch(
      (error: { stdout?: string; stderr?: string }) => {
        throw new Error(error.stdout || error.stderr || String(error));
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(skipGlsl)(
  'The programs of the rendering suite in GLSL ES',
  () => {
    it('are valid GLSL ES 3.00, their stages linked', async () => {
      const codegen = new GlslEsCodegen();
      const failures: string[] = [];
      let validated = 0;
      for (const program of programs.values()) {
        // WebGL2 emulates the compute stages by draws: a program per write.
        const compute = program.module.entryPoints.some(
          (entry) => entry.stage === 'compute',
        );
        const layout = std140LayoutStrategy.resolve(program.layout);
        try {
          if (compute) {
            for (const draw of codegen.emitCompute(program.module, layout)
              .draws) {
              await validateGlsl(draw.vertex, draw.fragment);
            }
          } else {
            const sources = codegen.emit(program.module, layout);
            if (sources.kind !== 'per-stage') {
              throw new Error('GLSL is a source per stage');
            }
            await validateGlsl(sources.vertex, sources.fragment);
          }
          validated++;
        } catch (error) {
          failures.push(`${program.name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
      expect(validated).toBeGreaterThan(30);
      // One glslangValidator run per program (per draw of a compute one).
    }, 30_000);
  },
);
