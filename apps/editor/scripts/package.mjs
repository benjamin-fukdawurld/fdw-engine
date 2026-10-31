// The executable of the editor (design/p11-windows.md §4): a portable
// executable under Windows, an AppImage under Linux, by electron-builder.
// What the engine process needs beside the bundle (out/) is gathered in
// dist/, the resources of the executable:
// - the addons, built or fetched in their packages, each with its DXC;
// - the models of the forest (the tps scene);
// - the programs of the scenes, precompiled with those addons
//   (scripts/precompile.ts), on Vulkan, and on Direct3D 12 under Windows.
//   Precompiling needs a device (a GPU, lavapipe, WARP); --no-precompile
//   ships none.
//
// node scripts/package.mjs [--no-precompile]   (nx run editor:package)
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addons } from '../../../tools/native/prebuilt.mjs';

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(editorRoot, '../..');
const resources = join(editorRoot, 'dist');

// The libraries of DXC, beside an addon.
const isDxc = (name) =>
  /^(dxcompiler\.dll|dxil\.dll|libdxcompiler\.so.*)$/.test(name);

// Rebuilt from scratch: nothing of a previous package (programs of older
// sources) is shipped.
rmSync(resources, { recursive: true, force: true });

// The addons, each in a directory of its own: the DXC of Vulkan (the SDK)
// and that of Direct3D 12 (the Windows SDK, with dxil.dll) differ.
const shipped = {};
for (const [name, addon] of Object.entries(addons)) {
  if (addon.platforms && !addon.platforms.includes(process.platform)) {
    continue;
  }
  const build = join(repositoryRoot, addon.root, 'build');
  const file = join(build, addon.file);
  if (!existsSync(file)) {
    throw new Error(`${file} is not built (nx run ${name}:build-native)`);
  }
  // A prebuilt addon comes with its DXC; one built here takes that of the
  // SDK.
  const prebuiltDxc = readdirSync(build)
    .filter(isDxc)
    .map((entry) => join(build, entry));
  const beside =
    prebuiltDxc.length > 0 ? prebuiltDxc : (addon.beside?.() ?? []);
  const directory = join(resources, 'addons', name);
  mkdirSync(directory, { recursive: true });
  for (const path of [file, ...beside]) {
    copyFileSync(path, join(directory, basename(path)));
  }
  shipped[name] = join(directory, addon.file);
}

cpSync(
  join(repositoryRoot, 'apps/docs/public/models/forest'),
  join(resources, 'models/forest'),
  { recursive: true },
);

if (!process.argv.includes('--no-precompile')) {
  const env = {
    ...process.env,
    FDW_VULKAN_ADDON: shipped['engine-vulkan'],
    FDW_D3D12_ADDON: shipped['engine-d3d12'],
    FDW_NATIVE_ADDON: shipped['engine-native'],
    FDW_MODELS: join(resources, 'models'),
  };
  // Only the DXC beside the addons, the one shipped.
  delete env.FDW_DXC_LIBRARY;
  const backends =
    process.platform === 'win32' ? ['vulkan', 'd3d12'] : ['vulkan'];
  for (const backend of backends) {
    execFileSync(
      process.execPath,
      [
        '--import',
        'jiti/register',
        join(editorRoot, 'scripts/precompile.ts'),
        join(resources, 'shaders'),
        backend,
      ],
      { cwd: repositoryRoot, stdio: 'inherit', env },
    );
  }
}

execFileSync(
  process.execPath,
  [
    join(editorRoot, 'node_modules/electron-builder/cli.js'),
    '--config',
    'electron-builder.yml',
    '--publish',
    'never',
  ],
  { cwd: editorRoot, stdio: 'inherit' },
);
