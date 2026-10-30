// The prebuilt addons (design/p11-windows.md §4): built by the CI on main
// (.github/workflows/addons.yml) and attached to a GitHub release per addon
// and per state of its native sources, `addons-<name>-<hash>`. The build
// scripts fetch the one of the current sources before running CMake: no
// compiler, CMake nor SDK is needed then. DXC comes with the addons that
// compile shaders, loaded from beside them.
//
// Usage (the CI):
//   node tools/native/prebuilt.mjs pack <out-dir>   the archives of the addons
//                                                   built here, and their tags
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Where the releases are: this repository, or FDW_PREBUILT_REPOSITORY
// (owner/name).
const repository =
  process.env.FDW_PREBUILT_REPOSITORY || 'benjamin-fukdawurld/fdw-engine';

// The libraries of DXC beside an addon: those it would load otherwise.
function vulkanDxc() {
  const sdk = process.env.VULKAN_SDK;
  if (!sdk) throw new Error('VULKAN_SDK is not set');
  return process.platform === 'win32'
    ? [join(sdk, 'Bin', 'dxcompiler.dll')]
    : [join(sdk, 'lib', 'libdxcompiler.so')];
}

// dxcompiler.dll and dxil.dll of the newest Windows SDK: Direct3D 12 needs
// the DXIL signed by the second.
function windowsSdkDxc() {
  const bin = join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits/10/bin',
  );
  const newest = readdirSync(bin)
    .filter((name) => name.startsWith('10.'))
    .map((name) => join(bin, name, 'x64'))
    .filter((directory) => existsSync(join(directory, 'dxil.dll')))
    .sort()
    .pop();
  if (!newest) throw new Error(`No dxil.dll in ${bin}`);
  return [join(newest, 'dxcompiler.dll'), join(newest, 'dxil.dll')];
}

/** The addons, by name: their package, their file, what comes with it. */
export const addons = {
  'engine-native': { root: 'packages/engine-native', file: 'fdw_native.node' },
  'engine-vulkan': {
    root: 'packages/engine-vulkan',
    file: 'fdw_vulkan.node',
    beside: vulkanDxc,
  },
  'engine-d3d12': {
    root: 'packages/engine-d3d12',
    file: 'fdw_d3d12.node',
    platforms: ['win32'],
    beside: windowsSdkDxc,
  },
  editor: { root: 'apps/editor', file: 'fdw_editor.node' },
};

const platform = `${process.platform}-${process.arch}`;

// The tar of the system: bsdtar under Windows (10 and later), rather than
// a GNU tar of the PATH (Git for Windows), which takes C: for a host.
const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

function git(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * The hash of the native sources of an addon (its native/ directory and
 * tools/native), from the blobs git has for them: the same on every system,
 * whatever the line endings of the checkout. Undefined when they differ
 * from git (changed locally) or without git: then only CMake knows.
 */
export function sourceHash(root) {
  const paths = [
    join(relative(repositoryRoot, root), 'native'),
    'tools/native',
  ].map((path) => path.replaceAll('\\', '/'));
  try {
    if (git(['status', '--porcelain', '--', ...paths]).trim() !== '') {
      return undefined;
    }
    const files = git(['ls-files', '--stage', '--', ...paths]);
    return createHash('sha256').update(files).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function addonOf(root) {
  const entry = Object.entries(addons).find(
    ([, addon]) => resolve(repositoryRoot, addon.root) === resolve(root),
  );
  if (!entry) throw new Error(`${root} has no prebuilt addon`);
  return { name: entry[0], ...entry[1] };
}

const tagOf = (name, hash) => `addons-${name}-${hash}`;
const assetOf = (name) => `${name}-${platform}.tar.gz`;

/**
 * Fetches the prebuilt addon of the package at `root` into its build/
 * directory, with what comes with it. False when there is none for these
 * sources and this system, or when `--from-source` or FDW_FROM_SOURCE asks
 * for CMake.
 */
export async function fetchPrebuilt(root) {
  if (process.argv.includes('--from-source') || process.env.FDW_FROM_SOURCE) {
    return false;
  }
  // A debug build is never prebuilt.
  if (process.argv.includes('--debug')) return false;
  const addon = addonOf(root);
  if (addon.platforms && !addon.platforms.includes(process.platform)) {
    return false;
  }
  const hash = sourceHash(root);
  if (!hash) return false;
  const build = join(root, 'build');
  const marker = join(build, '.prebuilt');
  if (
    existsSync(join(build, addon.file)) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8') === `${hash} ${platform}`
  ) {
    return true;
  }
  const url = `https://github.com/${repository}/releases/download/${tagOf(addon.name, hash)}/${assetOf(addon.name)}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.warn(`No prebuilt ${addon.name} (${error.message}): CMake`);
    return false;
  }
  if (!response.ok) {
    console.warn(`No prebuilt ${addon.name} for these sources: CMake`);
    return false;
  }
  const directory = mkdtempSync(join(tmpdir(), 'fdw-prebuilt-'));
  try {
    const archive = join(directory, assetOf(addon.name));
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    mkdirSync(build, { recursive: true });
    execFileSync(tar, ['-xzf', archive, '-C', build], { stdio: 'inherit' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  writeFileSync(marker, `${hash} ${platform}`);
  console.log(`Prebuilt ${addon.name} fetched (${hash}, ${platform})`);
  return true;
}

/**
 * The archives of the addons built here (CMake, in their build/), in
 * `out`: each with its tag, in tags.txt (`<tag> <file name>` per line).
 */
function pack(out) {
  mkdirSync(out, { recursive: true });
  const lines = [];
  for (const [name, addon] of Object.entries(addons)) {
    if (addon.platforms && !addon.platforms.includes(process.platform)) {
      continue;
    }
    const root = resolve(repositoryRoot, addon.root);
    const hash = sourceHash(root);
    if (!hash) throw new Error(`The native sources of ${name} differ from git`);
    const built = join(root, 'build', addon.file);
    if (!existsSync(built)) throw new Error(`${built} is not built`);
    const staging = mkdtempSync(join(tmpdir(), `fdw-${name}-`));
    for (const file of [built, ...(addon.beside?.() ?? [])]) {
      copyFileSync(file, join(staging, basename(file)));
    }
    const archive = resolve(out, assetOf(name));
    execFileSync(tar, ['-czf', archive, '-C', staging, '.'], {
      stdio: 'inherit',
    });
    rmSync(staging, { recursive: true, force: true });
    lines.push(`${tagOf(name, hash)} ${basename(archive)}`);
  }
  writeFileSync(join(out, 'tags.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [command, out] = process.argv.slice(2);
  if (command !== 'pack' || !out) {
    console.error('Usage: node tools/native/prebuilt.mjs pack <out-dir>');
    process.exit(1);
  }
  pack(out);
}
