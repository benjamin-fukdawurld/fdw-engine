import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ShaderSources } from '@fdw/engine-backend';
import { dxcArguments } from '../shader/HlslCodegen';
import { shaderKey, type ShaderCache } from '../shader/ShaderCache';

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
 * Runs `use` with a new temporary directory, removed after: the files of
 * the tools of a program in a single one.
 */
export async function withTemporaryDirectory<T>(
  use: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'fdw-spirv-'));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The version of the dxc of the SDK (`dxc --version`), asked once.
let dxcVersion: Promise<string> | undefined;

/** Where compileHlsl works, and what it can skip. */
export interface CompileHlslOptions {
  /** The directory of the files; a temporary one by default. */
  readonly dir?: string;
  /**
   * The SPIR-V of the modules already compiled, by shaderKey (the version
   * of DXC, its arguments and the HLSL): DXC only runs for the others.
   */
  readonly cache?: ShaderCache;
}

/**
 * Compiles the entry points of an HLSL module to SPIR-V with DXC: one
 * module per stage, the stages at the same time.
 */
export async function compileHlsl(
  sources: ShaderSources,
  options: CompileHlslOptions = {},
): Promise<Map<SpirvStage, Uint8Array>> {
  if (sources.kind !== 'single-module') {
    throw new Error('HLSL is a single module');
  }
  const { dir, cache } = options;
  if (!dir) {
    return withTemporaryDirectory((temporary) =>
      compileHlsl(sources, { ...options, dir: temporary }),
    );
  }
  const dxc = tool('dxc');
  const version = cache
    ? await (dxcVersion ??= runTool(dxc, ['--version']).then((out) =>
        out.trim(),
      ))
    : '';
  const input = join(dir, 'program.hlsl');
  let written: Promise<void> | undefined;
  const stages = (
    Object.entries(sources.entryPoints) as [SpirvStage, string | undefined][]
  ).filter((entry): entry is [SpirvStage, string] => !!entry[1]);
  const modules = await Promise.all(
    stages.map(async ([stage, entryPoint]) => {
      const args = dxcArguments(stage, entryPoint, 'vulkan', sources.code);
      const key = cache && shaderKey(version, 'vulkan', args, sources.code);
      const cached = key && cache.get(key);
      if (cached) {
        return cached;
      }
      await (written ??= writeFile(input, sources.code));
      const output = join(dir, `${stage}.spv`);
      await runTool(dxc, [...args, input, '-Fo', output]);
      const spirv = new Uint8Array(await readFile(output));
      if (key) cache.set(key, spirv);
      return spirv;
    }),
  );
  return new Map(stages.map(([stage], index) => [stage, modules[index]]));
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
function withModule<T>(
  spirv: Uint8Array,
  use: (path: string) => Promise<T>,
): Promise<T> {
  return withTemporaryDirectory(async (dir) => {
    const path = join(dir, 'module.spv');
    await writeFile(path, spirv);
    return use(path);
  });
}

const validate = (path: string) =>
  runTool(tool('spirv-val'), ['--target-env', 'vulkan1.3', path]);

/** Validates a SPIR-V module for Vulkan 1.3; throws with the messages. */
export async function validateSpirv(spirv: Uint8Array): Promise<void> {
  await withModule(spirv, validate);
}

/**
 * Validates a SPIR-V module (validateSpirv) and reflects its uniform blocks
 * (reflectUniformBlocks) from a single file, written in `dir`: spirv-val
 * and spirv-cross run side by side.
 */
export async function checkSpirv(
  spirv: Uint8Array,
  dir: string,
  name = 'module',
): Promise<Map<string, ReflectedBlock>> {
  const path = join(dir, `${name}.spv`);
  await writeFile(path, spirv);
  const [, blocks] = await Promise.all([validate(path), reflect(path)]);
  return blocks;
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
export function reflectUniformBlocks(
  spirv: Uint8Array,
): Promise<Map<string, ReflectedBlock>> {
  return withModule(spirv, reflect);
}

async function reflect(path: string): Promise<Map<string, ReflectedBlock>> {
  const json = await runTool(tool('spirv-cross'), [path, '--reflect']);
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
