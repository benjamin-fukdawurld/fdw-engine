// The duration budget of the tests (design/ci.md §3): the durations of the
// JUnit reports of a run (test-output/junit.xml of each project), compared
// with those of main. A test slower than its baseline by more than the
// threshold (50 % by default, --threshold 30) and by more than a margin
// (1 s by default, --margin 2: the small tests are noise) fails the
// budget. The baseline of a test is the median of its last five durations
// on main, kept in a JSON file the workflow carries in the cache of main.
// The tests skipped or failed are left out; those without a baseline are
// new. The table goes to the summary of the job.
// Usage:
//   node tools/ci/durations.mjs compare baseline.json [--threshold 50]
//     [--margin 1] [--no-fail]
//   node tools/ci/durations.mjs update baseline.json
import {
  appendFileSync,
  existsSync,
  globSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const [command, baselinePath] = args.filter((arg) => !arg.startsWith('--'));
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const threshold = option('threshold', 50);
const margin = option('margin', 1);
const fail = !args.includes('--no-fail');
// The durations kept per test on main.
const kept = 5;

if (!['compare', 'update'].includes(command) || !baselinePath) {
  console.error(
    'Usage: node tools/ci/durations.mjs compare|update baseline.json',
  );
  process.exit(2);
}

const unescape = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    return String.fromCodePoint(
      entity[1] === 'x'
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1)),
    );
  });

const attribute = (attributes, name) => {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match ? unescape(match[1]) : undefined;
};

// The tests passed of a report, in seconds, by `project > file > name`.
function readReport(path, durations) {
  // tests/rendering/test-output/junit.xml: the project tests/rendering.
  const project = dirname(dirname(path)).replaceAll('\\', '/');
  const xml = readFileSync(path, 'utf8');
  const testcase = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const [, attributes, body = ''] of xml.matchAll(testcase)) {
    if (/<(skipped|failure|error)\b/.test(body)) continue;
    const time = Number(attribute(attributes, 'time'));
    if (!Number.isFinite(time)) continue;
    const id = [
      project,
      attribute(attributes, 'classname'),
      attribute(attributes, 'name'),
    ]
      .filter(Boolean)
      .join(' > ');
    durations.set(id, time);
  }
}

const reports = globSync('{tests,packages,apps}/*/test-output/junit.xml');
const durations = new Map();
for (const report of reports) readReport(report, durations);
console.log(`${durations.size} tests in ${reports.length} JUnit reports`);

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8')).tests
  : undefined;

if (command === 'update') {
  // The new durations after the last ones; the tests not run this time
  // keep theirs.
  const tests = { ...baseline };
  for (const [id, time] of durations) {
    tests[id] = [...(tests[id] ?? []), time].slice(-kept);
  }
  writeFileSync(baselinePath, JSON.stringify({ version: 1, tests }));
  console.log(`${Object.keys(tests).length} tests in ${baselinePath}`);
  process.exit(0);
}

if (!baseline) {
  console.log(`No baseline (${baselinePath}): nothing to compare.`);
  process.exit(0);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const seconds = (time) => `${time.toFixed(2)} s`;

const rows = [];
for (const [id, time] of durations) {
  const before = baseline[id]?.length ? median(baseline[id]) : undefined;
  if (before === undefined) continue;
  const change = before > 0 ? ((time - before) / before) * 100 : Infinity;
  const over = change > threshold && time - before > margin;
  rows.push({ id, before, time, change, over });
}
const over = rows.filter((row) => row.over);
// The tests over budget, then the slowest ones.
const shown = [
  ...over,
  ...rows
    .filter((row) => !row.over)
    .sort((a, b) => b.time - a.time)
    .slice(0, 15),
];
const table = [
  `### Durations of the tests (${process.env['RUNNER_OS'] ?? process.platform})`,
  '',
  `${over.length} over budget (> +${threshold} % and > +${margin} s from the median of main), ${rows.length} compared, ${durations.size - rows.length} without a baseline.`,
  '',
  '| Test | main | now | change | |',
  '| ---- | ---: | --: | -----: | - |',
  ...shown.map(
    ({ id, before, time, change, over }) =>
      `| ${id.replaceAll('|', '\\|')} | ${seconds(before)} | ${seconds(time)} | ${
        change > 0 ? '+' : ''
      }${change.toFixed(0)} % | ${over ? 'over budget' : ''} |`,
  ),
  '',
].join('\n');
console.log(table);
if (process.env['GITHUB_STEP_SUMMARY']) {
  appendFileSync(process.env['GITHUB_STEP_SUMMARY'], table);
}
for (const { id, before, time } of over) {
  console.log(
    `::error title=Duration budget::${id}: ${seconds(time)}, ${seconds(before)} on main`,
  );
}
process.exit(over.length && fail ? 1 : 0);
