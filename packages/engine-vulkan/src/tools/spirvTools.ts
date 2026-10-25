import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ShaderSources } from '@fdw/engine-backend';
import { dxcArguments } from '../shader/HlslCodegen';

// The command line tools of the Vulkan SDK (DXC, spirv-val, spirv-cross),
// for tests and tooling. The backend itself will compile with the DXC
// library (phase 6, step 3).

const run = promisify(execFile);

/**
 * The path of a tool of the Vulkan SDK: in $VULKAN_SDK/bin, then in the
 * PATH; undefined when it is not installed.
 */
export function findTool(
  name: 'dxc' | 'spirv-val' | 'spirv-cross',
): string | undefined {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [
    ...(process.env['VULKAN_SDK']
      ? [join(process.env['VULKAN_SDK'], 'bin')]
      : []),
    ...(process.env['PATH'] ?? '').split(delimiter),
  ];
  return dirs.map((dir) => join(dir, file)).find((path) => existsSync(path));
}

const tool = (name: 'dxc' | 'spirv-val' | 'spirv-cross') => {
  const path = findTool(name);
  if (!path) {
    throw new Error(
      `${name} not found: install the Vulkan SDK and set VULKAN_SDK, or add it to the PATH`,
    );
  }
  return path;
};

// Runs a tool, with its output in the error when it fails.
async function runTool(path: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(path, args, { maxBuffer: 64 << 20 });
    return stdout;
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${path} ${args.join(' ')} failed:\n${stderr || stdout || String(error)}`,
    );
  }
}

export type SpirvStage = 'vertex' | 'fragment' | 'compute';

/**
 * Compiles the entry points of an HLSL module to SPIR-V with DXC: one
 * module per stage.
 */
export async function compileHlsl(
  sources: ShaderSources,
): Promise<Map<SpirvStage, Uint8Array>> {
  if (sources.kind !== 'single-module') {
    throw new Error('HLSL is a single module');
  }
  const dxc = tool('dxc');
  const dir = await mkdtemp(join(tmpdir(), 'fdw-hlsl-'));
  try {
    const input = join(dir, 'program.hlsl');
    await writeFile(input, sources.code);
    const result = new Map<SpirvStage, Uint8Array>();
    for (const [stage, entryPoint] of Object.entries(sources.entryPoints) as [
      SpirvStage,
      string | undefined,
    ][]) {
      if (!entryPoint) {
        continue;
      }
      const output = join(dir, `${stage}.spv`);
      await runTool(dxc, [
        ...dxcArguments(stage, entryPoint, 'vulkan', sources.code),
        input,
        '-Fo',
        output,
      ]);
      result.set(stage, new Uint8Array(await readFile(output)));
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Compiles the entry points of an HLSL module generated for Direct3D 12 to
 * DXIL with DXC: the disassembly of each stage, which describes the layout
 * of its cbuffers and structured buffers.
 */
export async function compileDxil(
  sources: ShaderSources,
): Promise<Map<SpirvStage, string>> {
  if (sources.kind !== 'single-module') {
    throw new Error('HLSL is a single module');
  }
  const dxc = tool('dxc');
  const dir = await mkdtemp(join(tmpdir(), 'fdw-dxil-'));
  try {
    const input = join(dir, 'program.hlsl');
    await writeFile(input, sources.code);
    const result = new Map<SpirvStage, string>();
    for (const [stage, entryPoint] of Object.entries(sources.entryPoints) as [
      SpirvStage,
      string | undefined,
    ][]) {
      if (!entryPoint) {
        continue;
      }
      const output = join(dir, `${stage}.txt`);
      await runTool(dxc, [
        ...dxcArguments(stage, entryPoint, 'd3d12', sources.code),
        input,
        '-Fc',
        output,
      ]);
      result.set(stage, await readFile(output, 'utf8'));
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Runs a tool on a SPIR-V module written to a temporary file.
async function withModule<T>(
  spirv: Uint8Array,
  use: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fdw-spirv-'));
  try {
    const path = join(dir, 'module.spv');
    await writeFile(path, spirv);
    return await use(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Validates a SPIR-V module for Vulkan 1.3; throws with the messages. */
export async function validateSpirv(spirv: Uint8Array): Promise<void> {
  const validator = tool('spirv-val');
  await withModule(spirv, (path) =>
    runTool(validator, ['--target-env', 'vulkan1.3', path]),
  );
}

/** A uniform block of a SPIR-V module, as reflected by spirv-cross. */
export interface ReflectedBlock {
  readonly set: number;
  readonly binding: number;
  readonly size: number;
  readonly members: readonly {
    readonly name: string;
    readonly offset: number;
  }[];
}

/** The uniform blocks of a SPIR-V module, by name of their variable. */
export async function reflectUniformBlocks(
  spirv: Uint8Array,
): Promise<Map<string, ReflectedBlock>> {
  const crossCompiler = tool('spirv-cross');
  const json = await withModule(spirv, (path) =>
    runTool(crossCompiler, [path, '--reflect']),
  );
  const reflection = JSON.parse(json) as {
    types: Record<
      string,
      { members: { name: string; offset: number }[] } | undefined
    >;
    ubos?: {
      type: string;
      name: string;
      set: number;
      binding: number;
      block_size: number;
    }[];
  };
  const blocks = new Map<string, ReflectedBlock>();
  for (const ubo of reflection.ubos ?? []) {
    blocks.set(ubo.name, {
      set: ubo.set,
      binding: ubo.binding,
      size: ubo.block_size,
      members: reflection.types[ubo.type]?.members ?? [],
    });
  }
  return blocks;
}
