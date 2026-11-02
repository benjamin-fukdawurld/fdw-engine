import {
  PhysicalProgramLayout,
  RenderBackend,
  std140LayoutStrategy,
} from '@fdw/engine-backend';
import type { CompiledProgram } from '@fdw/engine-shader';
import {
  checkSpirv,
  compileHlsl,
  FileShaderCache,
  findTool,
  HlslCodegen,
  withTemporaryDirectory,
  type ReflectedBlock,
} from '@fdw/engine-vulkan';
import { GlslEsCodegen } from '@fdw/engine-webgl2';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { canRun } from '@fdw/engine-backend/testing';

// Every program of the rendering suite in the other shading languages: the
// suite runs on Dawn (dawn.spec.ts, which validates the WGSL) while
// recording the programs of the pipelines it creates; each one is then
// generated
// - in HLSL, compiled to SPIR-V by DXC, validated by spirv-val, and its
//   uniform blocks reflected against the layout of the Vulkan backend;
// - in GLSL ES 3.00 (WebGL2), validated and linked by glslangValidator,
//   stricter than the compilers of the browsers: the compute stages as the
//   draws that emulate them.
// Needs Dawn and the Vulkan SDK (dxc, spirv-val, spirv-cross,
// glslangValidator). The programs are checked side by side, a temporary
// directory each; the SPIR-V of DXC is kept in the shader cache of the user
// (FileShaderCache, by version of DXC and HLSL), unless FDW_SHADER_CACHE is
// `off`.

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

/**
 * Records the programs of the pipelines the backend creates into
 * `programs`, by programKey.
 */
export function recordPrograms(
  backend: RenderBackend,
  programs: Map<string, CompiledProgram>,
): void {
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

// `check` on each item, as many at a time as the machine has cores: the
// tools are processes of their own. The messages of the failures.
async function checkAll<T>(
  items: Iterable<T>,
  check: (item: T) => Promise<void>,
  name: (item: T) => string,
): Promise<string[]> {
  const queue = [...items];
  const failures: string[] = [];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await check(item);
      } catch (error) {
        failures.push(`${name(item)}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(availableParallelism(), queue.length) },
      worker,
    ),
  );
  return failures.sort();
}

// The offsets of the uniform blocks of a module are those of the layout.
function expectLayout(
  reflected: Map<string, ReflectedBlock>,
  layout: PhysicalProgramLayout,
  name: string,
): void {
  for (const group of layout.groups) {
    for (const { binding, block, resource } of group.bindings) {
      const found = [...reflected.values()].find(
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

// Validates and links the stages of a GLSL ES program, written in `dir`.
async function validateGlsl(
  dir: string,
  name: string,
  vertex: string,
  fragment: string,
): Promise<void> {
  const files = [join(dir, `${name}.vert`), join(dir, `${name}.frag`)];
  await Promise.all([
    writeFile(files[0], vertex),
    writeFile(files[1], fragment),
  ]);
  await promisify(execFile)(glslang as string, ['-l', ...files]).catch(
    (error: { stdout?: string; stderr?: string }) => {
      throw new Error(error.stdout || error.stderr || String(error));
    },
  );
}

/**
 * The tests of the programs recorded by `programs`, once the suite that
 * records them has run (the tests of a file run in order). `dawn`: whether
 * that suite could run.
 */
export function describePrograms(
  programs: Map<string, CompiledProgram>,
  dawn: boolean,
): void {
  const skipHlsl = !canRun(
    'hlsl',
    dawn && sdk,
    'needs Dawn and the Vulkan SDK (dxc, spirv-val, spirv-cross)',
  );
  const skipGlsl = !canRun(
    'glsl',
    dawn && !!glslang,
    'needs Dawn and glslangValidator (Vulkan SDK)',
  );

  describe.skipIf(skipHlsl)(
    'The programs of the rendering suite in HLSL',
    () => {
      it('compile to valid SPIR-V, with the offsets of the layout', async () => {
        // Surfaces, raw stages, full screen passes, compute kernels, shadows…
        expect(programs.size).toBeGreaterThan(30);
        const codegen = new HlslCodegen();
        const cache = FileShaderCache.fromEnvironment();
        const failures = await checkAll(
          programs.values(),
          (program) =>
            withTemporaryDirectory(async (dir) => {
              const layout = std140LayoutStrategy.resolve(program.layout);
              const modules = await compileHlsl(
                codegen.emit(program.module, layout),
                { dir, cache },
              );
              const reflected = await Promise.all(
                [...modules].map(([stage, spirv]) =>
                  checkSpirv(spirv, dir, stage),
                ),
              );
              for (const blocks of reflected) {
                expectLayout(blocks, layout, program.name);
              }
            }),
          (program) => program.name,
        );
        expect(failures).toEqual([]);
      });
    },
  );

  describe.skipIf(skipGlsl)(
    'The programs of the rendering suite in GLSL ES',
    () => {
      it('are valid GLSL ES 3.00, their stages linked', async () => {
        const codegen = new GlslEsCodegen();
        let validated = 0;
        const failures = await checkAll(
          programs.values(),
          (program) =>
            withTemporaryDirectory(async (dir) => {
              // WebGL2 emulates the compute stages by draws: a program per
              // write.
              const compute = program.module.entryPoints.some(
                (entry) => entry.stage === 'compute',
              );
              const layout = std140LayoutStrategy.resolve(program.layout);
              if (compute) {
                const { draws } = codegen.emitCompute(program.module, layout);
                await Promise.all(
                  draws.map((draw, index) =>
                    validateGlsl(
                      dir,
                      `draw${index}`,
                      draw.vertex,
                      draw.fragment,
                    ),
                  ),
                );
              } else {
                const sources = codegen.emit(program.module, layout);
                if (sources.kind !== 'per-stage') {
                  throw new Error('GLSL is a source per stage');
                }
                await validateGlsl(
                  dir,
                  'program',
                  sources.vertex,
                  sources.fragment,
                );
              }
              validated++;
            }),
          (program) => program.name,
        );
        expect(failures).toEqual([]);
        expect(validated).toBeGreaterThan(30);
      });
    },
  );
}
