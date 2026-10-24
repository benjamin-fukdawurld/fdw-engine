// Measures the cost of the native viewport (step 5 of P18): the editor
// started on the display of the machine, its GPU, a scene shown in a
// viewport of 1280 × 720, then the same scene in a window of demo-native,
// without the editor around it. For each case: the frames per second, the
// CPU time of a frame (the stats of the engine), its GPU time (the passes
// of the level, measured by timestamps), the CPU used by each process
// (from /proc, in percent of a core). The GPU used by a process is not
// measured: nvidia-smi pmon samples it too coarsely to compare.
//
//   node apps/editor/scripts/measure.mjs [--seconds 10] [--repeat 3]
//     [--out file.json]
//
// Build the editor first (npx nx run editor:build, and the addons). The
// windows open on the screen: do not touch them while it runs.
import { _electron } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const editorRoot = join(import.meta.dirname, '..');
const repository = join(editorRoot, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const seconds = Number(option('--seconds', '10'));
// Each case run that many times: the medians are kept.
const repeat = Number(option('--repeat', '3'));
const output = option('--out');
const warmup = 4000;
const viewportSize = { width: 1280, height: 720 };
const ticks = 100; // USER_HZ: the unit of the times of /proc

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The processes under a pid, itself included.
function tree(root) {
  const children = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(
        stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1],
      );
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(entry));
    } catch {
      // Gone meanwhile.
    }
  }
  const pids = [];
  const visit = (pid) => {
    pids.push(pid);
    (children.get(pid) ?? []).forEach(visit);
  };
  visit(root);
  return pids;
}

// The role of a process of the editor, from its command line.
function role(pid) {
  let command = '';
  try {
    command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .join(' ');
  } catch {
    return undefined;
  }
  if (command.includes('dawn')) return 'dawn';
  if (command.includes('--type=renderer')) return 'renderer';
  if (command.includes('--type=gpu-process')) return 'gpu-process';
  if (command.includes('node.mojom.NodeService')) return 'engine';
  if (command.includes('--type=')) return 'other';
  return 'main';
}

function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

// The CPU of the processes under `root`, in percent of a core, by role,
// over `seconds`.
async function measureProcesses(root, roleOf) {
  const before = new Map(tree(root).map((pid) => [pid, cpuTicks(pid)]));
  const start = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000;
  const cpu = {};
  for (const pid of tree(root)) {
    const name = roleOf(pid);
    if (!name) continue;
    const used = (cpuTicks(pid) - (before.get(pid) ?? 0)) / ticks / elapsed;
    cpu[name] = (cpu[name] ?? 0) + used * 100;
  }
  const round = (values) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    );
  return { cpu: round(cpu) };
}

// The editor, a scene in its viewport of 1280 × 720.
async function measureEditor({ name, scene, backend = 'vulkan', over }) {
  const userData = mkdtempSync(join(tmpdir(), 'fdw-measure-'));
  const env = {
    ...process.env,
    FDW_USER_DATA: userData,
    FDW_SCENE: scene,
    FDW_BACKEND: backend,
  };
  env.FDW_NODE = process.execPath;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: join(editorRoot, 'node_modules/electron/dist/electron'),
    args: [editorRoot],
    cwd: editorRoot,
    env,
  });
  try {
    const page = await app.firstWindow();
    const footer = page.locator('footer');
    await footer.getByText(/ [1-9]\d* fps/).waitFor({ timeout: 60_000 });
    // The window grown or shrunk until the viewport has the size wanted.
    for (let i = 0; ; i++) {
      const box = await page.getByTestId('viewport').boundingBox();
      const ratio = await page.evaluate(() => window.devicePixelRatio);
      const dw = viewportSize.width / ratio - Math.round(box.width);
      const dh = viewportSize.height / ratio - Math.round(box.height);
      if (dw === 0 && dh === 0) break;
      if (i === 8) throw new Error('The window does not take the size asked');
      await app.evaluate(
        ({ BrowserWindow }, [dw, dh]) => {
          const window = BrowserWindow.getAllWindows()[0];
          const [width, height] = window.getContentSize();
          window.setContentSize(width + dw, height + dh);
        },
        [dw, dh],
      );
      await sleep(1000);
    }
    if (over) await over(page);
    await sleep(warmup);
    const stats = [];
    const listen = setInterval(async () => {
      const text = await footer.innerText().catch(() => '');
      const match =
        /(\d+) fps \(CPU ([\d.]+) ms(?:, GPU ([\d.]+) ms)?\) · (\d+) × (\d+)/.exec(
          text,
        );
      if (match) stats.push(match.slice(1).map(Number));
    }, 1000);
    const processes = await measureProcesses(app.process().pid, role);
    clearInterval(listen);
    const mean = (index) => {
      const values = stats
        .map((s) => s[index])
        .filter((v) => Number.isFinite(v));
      return values.length
        ? Math.round(
            (values.reduce((a, b) => a + b, 0) / values.length) * 100,
          ) / 100
        : undefined;
    };
    const last = stats.at(-1) ?? [];
    return {
      name,
      fps: mean(0),
      frameCpu: mean(1),
      frameGpu: mean(2),
      size: `${last[3]} × ${last[4]}`,
      ...processes,
    };
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

// The same scene in a window of demo-native (1280 × 720), on Vulkan.
async function measureDemo({ name, scene }) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'jiti/register',
      'apps/demo-native/src/main.ts',
      scene,
      '--vulkan',
    ],
    { cwd: repository, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await sleep(warmup + 4000);
    const processes = await measureProcesses(child.pid, () => 'demo');
    // Its title: "FdwEngine: <scene> (…), <n> fps, <w> × <h>".
    const windows = execFileSync('xwininfo', ['-root', '-tree'], {
      encoding: 'utf8',
    });
    const title = /FdwEngine: [^\n]*?(\d+) fps, (\d+) × (\d+)/.exec(windows);
    return {
      name,
      fps: title ? Number(title[1]) : undefined,
      size: title ? `${title[2]} × ${title[3]}` : undefined,
      ...processes,
    };
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

const results = [];
const median = (values) => {
  const sorted = values.filter((v) => v !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
};
// The median of each number of the runs, by key, nested objects included.
function medians(runs) {
  const result = {};
  for (const key of new Set(runs.flatMap(Object.keys))) {
    const values = runs.map((run) => run[key]);
    const first = values.find((value) => value !== undefined);
    result[key] =
      typeof first === 'number'
        ? median(values)
        : typeof first === 'object'
          ? medians(values.map((value) => value ?? {}))
          : first;
  }
  return result;
}

const run = async (measure, options) => {
  console.log(`· ${options.name}`);
  const runs = [];
  for (let i = 0; i < repeat; i++) runs.push(await measure(options));
  const result = medians(runs);
  console.log(JSON.stringify(result));
  results.push(result);
};

await run(measureEditor, { name: 'editor, level, Vulkan', scene: 'level' });
await run(measureEditor, {
  name: 'editor, level, Vulkan, command palette over it',
  scene: 'level',
  over: async (page) => {
    await page.getByTestId('viewport').focus();
    await page.keyboard.press('Control+Shift+P');
  },
});
await run(measureEditor, {
  name: 'editor, level, Dawn',
  scene: 'level',
  backend: 'dawn',
});
await run(measureEditor, { name: 'editor, tps, Vulkan', scene: 'tps' });
await run(measureDemo, { name: 'demo-native, tps, Vulkan', scene: 'tps' });
await run(measureEditor, { name: 'editor, shadows, Vulkan', scene: 'shadows' });
await run(measureDemo, {
  name: 'demo-native, shadows, Vulkan',
  scene: 'shadows',
});

if (output) writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`);
