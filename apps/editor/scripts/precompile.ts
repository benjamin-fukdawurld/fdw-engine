// The programs of the editor, precompiled for its executable
// (design/p11-windows.md §5): its scenes played on an offscreen surface,
// on Vulkan or on Direct3D 12, their programs compiled by DXC into a cache
// directory. The executable ships it (scripts/package.mjs), read before
// the cache of the user: the first start does not run DXC. The addons and
// DXC must be those shipped, the key of a program having the version of
// DXC: FDW_VULKAN_ADDON, FDW_D3D12_ADDON, FDW_NATIVE_ADDON (the images),
// FDW_MODELS (the forest of tps) are given by scripts/package.mjs.
//
// node --import jiti/register apps/editor/scripts/precompile.ts <directory> vulkan|d3d12
import type { Engine, Surface } from '@fdw/engine-backend';
import { D3D12Engine, D3D12OffscreenSurface } from '@fdw/engine-d3d12';
import { pixelCodec } from '@fdw/engine-assets';
import { createStbImageDecoder } from '@fdw/engine-resources-native';
import {
  FileShaderCache,
  VulkanEngine,
  VulkanOffscreenSurface,
} from '@fdw/engine-vulkan';
import { EditorEngine } from '@fdw/editor-ui/engine';
import {
  levelRenderings,
  levelScene,
  type EngineMessage,
  type PageMessage,
  type ViewportTool,
} from '@fdw/editor-ui/protocol';
import { graphsExtension } from '@fdw/graph-editor/engine';

const [directory, backendName] = process.argv.slice(2);
if (!directory || (backendName !== 'vulkan' && backendName !== 'd3d12')) {
  console.error('Usage: precompile.ts <directory> vulkan|d3d12');
  process.exit(2);
}
// The scenes read FDW_MODELS when loaded.
const { scenes } = await import('../src/engine/scenes');

// The size of the viewport: some programs depend on it (the tiles of the
// lights).
const width = 1280;
const height = 720;
// A step is done once its scene has drawn this many frames, for this long,
// without a new program (models still loading); it gives up after the time
// out.
const quietFrames = 60;
const quietTime = 2000;
const stepTimeout = 60_000;

const cache = new FileShaderCache(directory);
let engine: Engine & { device?: { waitIdle(): void } };
let surface: Surface;
// The format of a swapchain, as in the viewport.
if (backendName === 'vulkan') {
  engine = new VulkanEngine({
    application: 'FDW Editor precompile',
    shaderCache: cache,
  });
  surface = new VulkanOffscreenSurface(width, height, 'bgra8unorm');
} else {
  engine = new D3D12Engine({
    application: 'FDW Editor precompile',
    shaderCache: cache,
  });
  surface = new D3D12OffscreenSurface(width, height, 'bgra8unorm');
}
await engine.init();
await surface.init(engine);
const backend = engine.backend;
if (!backend) throw new Error(`The ${backendName} engine is not ready`);

// The frames drawn, and those waiting for the next.
let frames = 0;
let waiters: (() => void)[] = [];
// The next frame, or a moment: no frames while no scene is shown.
const nextFrame = () =>
  new Promise<void>((resolve) => {
    waiters.push(resolve);
    setTimeout(resolve, 100);
  });

// The scene shown, and what the engine tells the page.
let shown: string | undefined;
const nodes = new Set<string>();
let failures = 0;
function receive(message: EngineMessage): void {
  if (message.type === 'error') {
    failures++;
    console.error(`  ${message.message}`);
  } else if (message.type === 'level.nodes') {
    if (message.reset) nodes.clear();
    for (const node of message.nodes) nodes.add(node.id);
    for (const id of message.removed) nodes.delete(id);
  }
}

const editor = new EditorEngine(
  {
    backend,
    backendName,
    device: backendName,
    viewport: {
      bounds: { x: 0, y: 0, width, height },
      setBounds: () => undefined,
    },
    createSurface: async () => surface,
    waitIdle: () => engine.device?.waitIdle(),
    nextFrame: async () => {
      // An offscreen surface does not set a pace: one frame in flight.
      engine.device?.waitIdle();
      frames++;
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
      await new Promise((resolve) => setImmediate(resolve));
    },
    scenes,
    imageCodecs: [pixelCodec(createStbImageDecoder())],
    extensions: [
      graphsExtension(),
      {
        id: 'precompile',
        create: () => ({
          scene: (_scene, name) => {
            shown = name;
          },
        }),
      },
    ],
  },
  levelScene,
);
editor.connect({ post: receive, close: () => undefined });
const send = (message: PageMessage) => editor.receive(message);
const running = editor.run();

/**
 * Draws the scene `name` until no program is compiled for `quietFrames`
 * frames and `quietTime` ms.
 */
async function settle(step: string, name: string): Promise<void> {
  const begin = performance.now();
  const compiled = cache.misses;
  const failed = failures;
  let quiet = 0;
  let quietSince = performance.now();
  let misses = cache.misses;
  while (quiet < quietFrames || performance.now() - quietSince < quietTime) {
    if (performance.now() - begin > stepTimeout) {
      failures++;
      console.error(`  ${step}: still compiling after ${stepTimeout} ms`);
      break;
    }
    // A scene that failed is not shown.
    if (failures > failed && shown !== name) break;
    const drawn = frames;
    await nextFrame();
    if (shown !== name || cache.misses !== misses) {
      quiet = 0;
      quietSince = performance.now();
      misses = cache.misses;
    } else if (frames > drawn) {
      quiet++;
    }
  }
  const time = Math.round(performance.now() - begin);
  console.log(`${step}: ${cache.misses - compiled} programs (${time} ms)`);
}

console.log(`Precompiling the editor on ${backendName} into ${directory}`);
await settle(levelScene, levelScene);
// The selection and its gizmos.
send({ type: 'level.command', command: 'select', ids: [...nodes] });
for (const tool of ['translate', 'rotate', 'scale'] as ViewportTool[]) {
  send({ type: 'level.tool', tool });
  await settle(`${levelScene} (${tool})`, levelScene);
}
send({ type: 'level.tool', tool: 'select' });
// The renderings with rays, where the backend traces them.
if (backend.capabilities?.rayQuery === true) {
  for (const rendering of levelRenderings) {
    send({ type: 'level.rendering', rendering });
    await settle(`${levelScene} (${rendering})`, levelScene);
  }
}
for (const name of Object.keys(scenes)) {
  send({ type: 'scene', name });
  await settle(name, name);
}

editor.stop();
await running;
editor.destroy();
console.log(`${cache.misses} programs compiled in ${frames} frames`);
await engine.destroy();
process.exit(failures > 0 ? 1 : 0);
