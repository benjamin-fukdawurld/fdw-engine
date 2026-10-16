// Runs the benchmarks (*.bench.ts) of every package, and writes their
// results as one JSON file: { benchmarks: [{ name, mean, rme }] }, mean in
// milliseconds, rme the relative margin of error in percent.
// Usage: node tools/bench/run.mjs <output.json> [--root <workspace>]
// --root runs the benchmarks of another checkout (the base of a change).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : '.');
// The first argument that is not --root nor its value.
const output = resolve(
  args.find(
    (arg, i) => !arg.startsWith('--') && (rootIndex < 0 || i !== rootIndex + 1),
  ) ?? 'bench.json',
);

// The packages with benchmarks.
const hasBench = (dir) =>
  readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? hasBench(join(dir, entry.name))
      : entry.name.endsWith('.bench.ts'),
  );
const packages = readdirSync(join(root, 'packages')).filter((name) => {
  const src = join(root, 'packages', name, 'src');
  return existsSync(src) && hasBench(src);
});

const benchmarks = [];
const scratch = mkdtempSync(join(tmpdir(), 'fdw-bench-'));
for (const name of packages) {
  const dir = join(root, 'packages', name);
  const report = join(scratch, `${name}.json`);
  console.log(`Benchmarks of ${name}`);
  execFileSync('npx', ['vitest', 'bench', '--run', '--outputJson', report], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const { files } = JSON.parse(readFileSync(report, 'utf8'));
  for (const file of files) {
    for (const group of file.groups) {
      for (const bench of group.benchmarks) {
        // The group name holds the file, relative to the package.
        benchmarks.push({
          name: `${name} › ${group.fullName.replace(/^.*? > /, '')} › ${
            bench.name
          }`,
          file: relative(root, file.filepath),
          mean: bench.mean,
          rme: bench.rme,
        });
      }
    }
  }
}
writeFileSync(output, JSON.stringify({ benchmarks }, null, 2) + '\n');
console.log(`${benchmarks.length} benchmarks written to ${output}`);
