// Compares two results of tools/bench/run.mjs, the base of a change and the
// change, as a Markdown table. A benchmark slower by more than the threshold
// (20 % by default, --threshold 30) and more than its margins of error is a
// regression; faster in the same way, an improvement. Never fails: the
// runners of the CI are noisy, the table is for a human to read.
// Usage: node tools/bench/compare.mjs base.json head.json [--threshold 20]
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [basePath, headPath] = args.filter((arg) => !arg.startsWith('--'));
const thresholdIndex = args.indexOf('--threshold');
const threshold = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) : 20;

const load = (path) =>
  new Map(
    JSON.parse(readFileSync(path, 'utf8')).benchmarks.map((bench) => [
      bench.name,
      bench,
    ])
  );
const base = load(basePath);
const head = load(headPath);

const time = (ms) =>
  ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(1)} µs`;

const rows = [];
let regressions = 0;
let improvements = 0;
for (const [name, after] of head) {
  const before = base.get(name);
  if (!before) {
    rows.push(`| ${name} | — | ${time(after.mean)} | new | |`);
    continue;
  }
  const change = ((after.mean - before.mean) / before.mean) * 100;
  // Beyond the threshold, and beyond the noise of both measures.
  const significant =
    Math.abs(change) > threshold && Math.abs(change) > before.rme + after.rme;
  let mark = '';
  if (significant && change > 0) {
    mark = '🔴 slower';
    regressions++;
  } else if (significant) {
    mark = '🟢 faster';
    improvements++;
  }
  const sign = change > 0 ? '+' : '';
  rows.push(
    `| ${name} | ${time(before.mean)} | ${time(
      after.mean
    )} | ${sign}${change.toFixed(1)} % | ${mark} |`
  );
}
for (const name of base.keys()) {
  if (!head.has(name)) {
    rows.push(`| ${name} | ${time(base.get(name).mean)} | — | removed | |`);
  }
}

console.log(`## Benchmarks

${regressions} slower, ${improvements} faster, beyond ${threshold} % and the margins of error (the runners are shared: a single run is only a hint).

| Benchmark | Base | Change | Δ | |
| --- | ---: | ---: | ---: | --- |
${rows.join('\n')}`);
