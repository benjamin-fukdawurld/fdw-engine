import { readFileSync } from 'node:fs';
import baseConfig from '../../eslint.config.mjs';

// The editor installs its packages on its own (apps/editor/node_modules,
// its own package-lock.json), outside the root workspaces: the project graph
// of Nx, built from the root lockfile, does not know `electron` or
// `electron-vite`. `@nx/enforce-module-boundaries` then resolves them on
// disk, under apps/editor, and takes them for files of the editor imported
// by package name. Its packages are allowed by name (and subpath); the rule
// keeps checking the rest.
const rule = '@nx/enforce-module-boundaries';
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const ownPackages = Object.keys({
  ...pkg.dependencies,
  ...pkg.devDependencies,
}).map((name) => `^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(/.*)?$`);
const [level, options] = baseConfig.findLast((c) => c.rules?.[rule]).rules[
  rule
];

export default [
  ...baseConfig,
  { ignores: ['out', 'build'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      [rule]: [
        level,
        { ...options, allow: [...(options.allow ?? []), ...ownPackages] },
      ],
    },
  },
];
