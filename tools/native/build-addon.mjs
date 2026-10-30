// Builds a Node-API addon with CMake: the native/ directory of a package
// into its build/ directory. Shared by the native packages (engine-native,
// engine-vulkan, engine-d3d12) and the editor.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The Node-API headers and, for the Windows import library of node.exe,
// node_api.def: those of node-api-headers. Node-API is ABI stable: any
// headers build an addon loadable by every Node version.
// NODE_API_INCLUDE_DIR overrides the headers.
export function findNodeApi() {
  const { include_dir, def_paths } = createRequire(import.meta.url)(
    'node-api-headers',
  );
  return {
    includeDir: process.env.NODE_API_INCLUDE_DIR || include_dir,
    def: def_paths.node_api_def,
  };
}

export { fetchPrebuilt } from './prebuilt.mjs';

/**
 * Configures and builds `<root>/native` into `<root>/build`, Release by
 * default (`--debug` on the command line for Debug). The build scripts try
 * fetchPrebuilt first.
 */
export function buildAddon(root, extraArguments = []) {
  const buildType = process.argv.includes('--debug') ? 'Debug' : 'Release';
  const nodeApi = findNodeApi();
  const run = (...args) =>
    execFileSync('cmake', args, { cwd: root, stdio: 'inherit' });
  run(
    '-S',
    'native',
    '-B',
    'build',
    `-DCMAKE_BUILD_TYPE=${buildType}`,
    `-DNODE_API_INCLUDE_DIR=${nodeApi.includeDir}`,
    `-DNODE_API_DEF=${nodeApi.def}`,
    ...extraArguments,
  );
  run('--build', 'build', '--config', buildType, '--parallel');
}
