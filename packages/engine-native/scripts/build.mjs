// Builds the native addon with CMake: build/fdw_native.node.
// Usage: node scripts/build.mjs [--debug]
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildType = process.argv.includes('--debug') ? 'Debug' : 'Release';

// The Node-API headers. Node-API is ABI stable: the headers of any Node
// installation build an addon loadable by every version. Looked for in
// NODE_API_INCLUDE_DIR, next to the running Node, then next to the Node
// binaries of the PATH (the running one can come without headers, as the
// `node` package of node_modules, which Nx uses).
function findNodeApi() {
  const binaries = [
    process.execPath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .map((dir) =>
        join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
      )
      .filter((path) => existsSync(path)),
  ];
  const candidates = [
    process.env.NODE_API_INCLUDE_DIR,
    ...binaries.flatMap((binary) =>
      [binary, realpathSync(binary)].map((path) =>
        resolve(dirname(path), '..', 'include', 'node')
      )
    ),
  ].filter(Boolean);
  const found = candidates.find((dir) => existsSync(join(dir, 'node_api.h')));
  if (!found) {
    throw new Error(
      `node_api.h not found (looked in ${candidates.join(
        ', '
      )}): set NODE_API_INCLUDE_DIR`
    );
  }
  return found;
}
const nodeApi = findNodeApi();

const run = (...args) =>
  execFileSync('cmake', args, { cwd: root, stdio: 'inherit' });
run(
  '-S',
  'native',
  '-B',
  'build',
  `-DCMAKE_BUILD_TYPE=${buildType}`,
  `-DNODE_API_INCLUDE_DIR=${nodeApi}`
);
run('--build', 'build', '--config', buildType, '--parallel');
