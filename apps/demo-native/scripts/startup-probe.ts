// The startup of the native demo, measured (design/p11-windows.md §5):
// loaded before it, this probe wraps the calls of the Vulkan and Direct3D 12
// addons that compile (DXC: createShader, compileHlsl; the driver:
// createRenderPipeline, createComputePipeline) and the HLSL codegen, and prints at exit, in ms
// since the start of the process: their totals, the first image, and the
// last pipeline created (the scene is then ready).
//
// node --import jiti/register --import ./apps/demo-native/scripts/startup-probe.ts \
//   apps/demo-native/src/main.ts tps --vulkan --frames 300 --hidden --no-audio
import { addonPath as d3d12Path } from '@fdw/engine-d3d12';
import { addonPath as vulkanPath, HlslCodegen } from '@fdw/engine-vulkan';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

interface Total {
  count: number;
  ms: number;
}

const totals = new Map<string, Total>();
const marks = new Map<string, number>();

function add(name: string, ms: number): void {
  const total = totals.get(name) ?? { count: 0, ms: 0 };
  total.count++;
  total.ms += ms;
  totals.set(name, total);
}

// A wrapper timing a function: `after` runs once it returns.
function timed<F extends (...args: never[]) => unknown>(
  original: F,
  name: string,
  after?: () => void,
): F {
  return function (this: unknown, ...args: Parameters<F>) {
    const begin = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      add(name, performance.now() - begin);
      after?.();
    }
  } as F;
}

marks.set('probe loaded', performance.now());

const firstTime = (name: string) => () => {
  if (!marks.has(name)) marks.set(name, performance.now());
};
const lastTime = (name: string) => () => marks.set(name, performance.now());

// The functions of an addon are read-only: the module the packages load
// (the same, from the cache of require) is replaced by a copy, some of its
// functions timed.
const require = createRequire(import.meta.url);
const timings: Record<string, [string, (() => void)?]> = {
  createContext: ['context', firstTime('context created')],
  createShader: ['DXC (createShader)'],
  compileHlsl: ['DXC (compileHlsl, for the cache)'],
  createShaderFromCode: ['createShaderFromCode'],
  createRenderPipeline: [
    'driver (createRenderPipeline)',
    lastTime('last pipeline'),
  ],
  createComputePipeline: [
    'driver (createComputePipeline)',
    lastTime('last pipeline'),
  ],
  acquireImage: ['acquireImage', firstTime('first image')],
};
for (const path of [vulkanPath(), d3d12Path()]) {
  if (!existsSync(path)) continue;
  const addon = require(path) as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(addon)) {
    const original = addon[key];
    const timing = timings[key];
    copy[key] =
      timing && typeof original === 'function'
        ? timed(original as () => unknown, ...timing)
        : original;
  }
  const cached = require.cache[require.resolve(path)];
  if (cached) cached.exports = copy;
}
HlslCodegen.prototype.emit = timed(
  HlslCodegen.prototype.emit,
  'HLSL codegen (emit)',
);

process.on('exit', () => {
  const lines = ['', `startup (ms since the start of the process)`];
  for (const [name, at] of marks) {
    lines.push(`  ${name.padEnd(34)} at ${at.toFixed(0)}`);
  }
  for (const [name, { count, ms }] of totals) {
    lines.push(
      `  ${name.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms, ${count}`,
    );
  }
  console.log(lines.join('\n'));
});
