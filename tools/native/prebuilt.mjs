// The prebuilt addons (design/p11-windows.md §4): built by the CI on main
// (.github/workflows/addons.yml) and attached to a GitHub release per addon
// and per state of its native sources, `addons-<name>-<hash>`. The build
// scripts fetch the one of the current sources before running CMake: no
// compiler, CMake nor SDK is needed then. DXC comes with the addons that
// compile shaders, loaded from beside them.
//
// Each archive comes with its SHA-256 (`<archive>.sha256`): the download is
// checked against it, and an archive without one is not used.
//
// Usage (the CI):
//   node tools/native/prebuilt.mjs pack <out-dir>   the archives of the addons
//                                                   built here, and their tags
//   node tools/native/prebuilt.mjs smoke <out-dir>  each archive unpacked and
//                                                   its addon loaded
//   node tools/native/prebuilt.mjs tags             the tag and archives of
//                                                   each addon, per system
//   node tools/native/prebuilt.mjs windows-sdk      the Windows SDK DXC comes
//                                                   from (an input of Nx)
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
import { createRequire } from 'node:module';
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

// The x64 binaries of the newest Windows SDK with a dxil.dll; undefined
// without one.
function windowsSdkBin() {
  const bin = join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits/10/bin',
  );
  if (!existsSync(bin)) return undefined;
  return readdirSync(bin)
    .filter((name) => name.startsWith('10.'))
    .map((name) => join(bin, name, 'x64'))
    .filter((directory) => existsSync(join(directory, 'dxil.dll')))
    .sort()
    .pop();
}

// dxcompiler.dll and dxil.dll of the newest Windows SDK: Direct3D 12 needs
// the DXIL signed by the second.
function windowsSdkDxc() {
  const newest = windowsSdkBin();
  if (!newest) throw new Error('No Windows SDK with a dxil.dll');
  return [join(newest, 'dxcompiler.dll'), join(newest, 'dxil.dll')];
}

// The version of the Node-API headers the addons are built against.
const nodeApiHeadersVersion = () =>
  createRequire(import.meta.url)('node-api-headers/package.json').version;

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
 * The hash of the native sources of an addon (its native/ and scripts/
 * directories, and tools/native with VULKAN_SDK_VERSION, the version of
 * the SDK the CI builds with and ships the DXC of), from the blobs git
 * has for them, and of the version of node-api-headers: the same on every
 * system, whatever the line endings of the checkout. Undefined when they
 * differ from git (changed locally) or without git: then only CMake knows.
 */
export function sourceHash(root) {
  const project = relative(repositoryRoot, root);
  const paths = [
    join(project, 'native'),
    join(project, 'scripts'),
    'tools/native',
  ].map((path) => path.replaceAll('\\', '/'));
  try {
    if (git(['status', '--porcelain', '--', ...paths]).trim() !== '') {
      return undefined;
    }
    const files = git(['ls-files', '--stage', '--', ...paths]);
    return createHash('sha256')
      .update(files)
      .update(`node-api-headers ${nodeApiHeadersVersion()}`)
      .digest('hex')
      .slice(0, 16);
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
const assetOf = (name, of = platform) => `${name}-${of}.tar.gz`;

// The systems the CI builds the addons for (addons.yml).
const releasedPlatforms = { linux: 'linux-x64', win32: 'win32-x64' };
const sha256Of = (data) => createHash('sha256').update(data).digest('hex');

// The addons of this system.
const localAddons = () =>
  Object.entries(addons).filter(
    ([, addon]) =>
      !addon.platforms || addon.platforms.includes(process.platform),
  );

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

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
  let data;
  try {
    // The checksum first: an archive without one is not used.
    const expected = (await download(`${url}.sha256`)).toString().trim();
    data = await download(url);
    if (sha256Of(data) !== expected) {
      console.warn(`The prebuilt ${addon.name} fails its SHA-256: CMake`);
      return false;
    }
  } catch (error) {
    console.warn(`No prebuilt ${addon.name} (${error.message}): CMake`);
    return false;
  }
  const directory = mkdtempSync(join(tmpdir(), 'fdw-prebuilt-'));
  try {
    const archive = join(directory, assetOf(addon.name));
    writeFileSync(archive, data);
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
 * `out`, each with its SHA-256 (`<archive>.sha256`) and its tag, in
 * tags.txt (`<tag> <file name>` per line).
 */
function pack(out) {
  mkdirSync(out, { recursive: true });
  const lines = [];
  for (const [name, addon] of localAddons()) {
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
    writeFileSync(`${archive}.sha256`, `${sha256Of(readFileSync(archive))}\n`);
    lines.push(`${tagOf(name, hash)} ${basename(archive)}`);
  }
  writeFileSync(join(out, 'tags.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

/**
 * Each archive of `out` (written by pack) checked against its SHA-256,
 * unpacked alone in a temporary directory, and its addon loaded from there
 * by a Node of its own: what fetchPrebuilt gives a workstation.
 */
function smoke(out) {
  const lines = readFileSync(join(out, 'tags.txt'), 'utf8').split('\n');
  for (const file of lines.filter(Boolean).map((line) => line.split(' ')[1])) {
    const [name, addon] = localAddons().find(
      ([candidate]) => assetOf(candidate) === file,
    );
    const archive = join(out, file);
    const expected = readFileSync(`${archive}.sha256`, 'utf8').trim();
    if (sha256Of(readFileSync(archive)) !== expected) {
      throw new Error(`${archive} fails its SHA-256`);
    }
    const directory = mkdtempSync(join(tmpdir(), `fdw-smoke-${name}-`));
    try {
      execFileSync(tar, ['-xzf', archive, '-C', directory], {
        stdio: 'inherit',
      });
      execFileSync(
        process.execPath,
        [
          '-e',
          'process.dlopen({ exports: {} }, process.argv[1])',
          join(directory, addon.file),
        ],
        { stdio: 'inherit' },
      );
      console.log(`${name}: loaded from its archive`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [command, out] = process.argv.slice(2);
  if (command === 'pack' && out) {
    pack(out);
  } else if (command === 'smoke' && out) {
    smoke(out);
  } else if (command === 'tags') {
    for (const [name, addon] of Object.entries(addons)) {
      const hash = sourceHash(resolve(repositoryRoot, addon.root));
      if (!hash)
        throw new Error(`The native sources of ${name} differ from git`);
      for (const [system, of] of Object.entries(releasedPlatforms)) {
        if (!addon.platforms || addon.platforms.includes(system)) {
          console.log(`${tagOf(name, hash)} ${assetOf(name, of)}`);
        }
      }
    }
  } else if (command === 'windows-sdk') {
    console.log(windowsSdkBin() ?? 'none');
  } else {
    console.error(
      'Usage: node tools/native/prebuilt.mjs pack|smoke <out-dir> | tags | windows-sdk',
    );
    process.exit(1);
  }
}
