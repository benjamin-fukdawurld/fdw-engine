// The demo scenes in a native window, outside of the browser (see
// design/native-backends.md):
// - WebGPU on Dawn, presented by copy (default);
// - Vulkan, presented by a swapchain (--vulkan), with the validation layer
//   when the Vulkan SDK is set up (--validation);
// - Direct3D 12 on Windows, presented by a DXGI swapchain (--d3d12), with
//   the debug layer when the Graphics Tools are installed (--validation).
//
// nx run demo-native:start [-- <scene>] [--vulkan | --d3d12] [--validation]
//   [--no-vsync] [--frames <count>] [--hidden] [--no-audio]
// Scenes: shadows (default), pbr, maze (maze-1 to maze-3 for its first steps),
// fps (the first person shooter; P pauses),
// city (the occlusion culling; city-no-occlusion to compare), decor (the
// static batching; decor-no-batching to compare), terrain (the
// tessellation; terrain-uniform: every patch at the finest level), physics
// (the physics playground, on Rapier), tps (the third-person game in the
// forest; its models from apps/docs/public/models/forest), procedural (the
// gallery of procedural materials; F switches the filter of the floor),
// coast (the sea of an ocean spectrum, crates and a boat floating on it; G
// switches to Gerstner waves; coast-gerstner starts with them).
// The sounds play on the default device, through miniaudio (--no-audio:
// silent).
// Escape or closing the window quits.
import { NativeAudioEngine } from '@fdw/engine-audio-native';
import type { Engine, Surface } from '@fdw/engine-backend';
import { D3D12Engine } from '@fdw/engine-d3d12';
import {
  createDawnEngine,
  D3D12WindowSurface,
  DawnWindowSurface,
  NativeWindow,
  NativeWindowEvent,
  runLoop,
  VulkanWindowSurface,
} from '@fdw/engine-native';
import { NativeInputSource } from '@fdw/engine-input-native';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { VulkanEngine } from '@fdw/engine-vulkan';
import {
  createCity,
  createCityScene,
  createCoast,
  createCoastScene,
  createDecor,
  createDecorScene,
  createTerrain,
  createTerrainScene,
  createMazeStep1,
  createMazeStep2,
  createMazeStep3,
  createMazeStep4,
  createFpsScene,
  createPbrScene,
  createPhysicsScene,
  createProceduralGallery,
  createShadowsScene,
  createTpsScene,
  TpsLevelPath,
  SceneFactory,
} from '@fdw/demo-scenes';
import { installAssets, pixelCodec } from '@fdw/engine-assets';
import { installGltf } from '@fdw/engine-gltf';
import { ResourceStore } from '@fdw/engine-resources';
import {
  createStbImageDecoder,
  FileSource,
} from '@fdw/engine-resources-native';
import { fileURLToPath } from 'node:url';

const scenes: Record<string, SceneFactory> = {
  shadows: createShadowsScene,
  pbr: createPbrScene,
  // The game: its last step, and the steps before.
  maze: createMazeStep4,
  'maze-1': createMazeStep1,
  'maze-2': createMazeStep2,
  'maze-3': createMazeStep3,
  fps: createFpsScene,
  city: createCityScene,
  'city-no-occlusion': createCity({ occlusion: false }),
  decor: createDecorScene,
  'decor-no-batching': createDecor({ batching: false }),
  terrain: createTerrainScene,
  'terrain-uniform': createTerrain({ minLevel: 6 }),
  procedural: createProceduralGallery,
};
// The scenes loading something first: Rapier, the same WebAssembly module
// as in the browser.
const loadedScenes: Record<string, () => Promise<SceneFactory>> = {
  physics: async () => createPhysicsScene(await createRapierPhysics()),
  coast: async () => createCoastScene(await createRapierPhysics()),
  'coast-gerstner': async () =>
    createCoast(await createRapierPhysics(), { waves: 'gerstner' }),
  tps: async () => {
    // The files of the documentation: the models of the forest.
    const store = new ResourceStore();
    const models = fileURLToPath(
      new URL('../../docs/public/models', import.meta.url),
    );
    store.mount('file', new FileSource(models), { default: true });
    installAssets(store, { codecs: [pixelCodec(createStbImageDecoder())] });
    installGltf(store);
    return createTpsScene({
      physics: await createRapierPhysics(),
      resources: () => store,
      level: TpsLevelPath,
    });
  },
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const name =
  args.find(
    (arg) => !arg.startsWith('--') && (arg in scenes || arg in loadedScenes),
  ) ?? 'shadows';
// Stops after this many frames (tests, profiling).
const maxFrames = Number(option('--frames') ?? Infinity);
const vulkan = args.includes('--vulkan');
const d3d12 = args.includes('--d3d12');
const vsync = !args.includes('--no-vsync');

// The engine, the window and its surface for the chosen backend.
let engine: Engine;
let surface: Surface & { destroy(): void };
let throttle: (() => Promise<void>) | undefined;
let title: string;
let window: NativeWindow;
if (vulkan) {
  const vulkanEngine = new VulkanEngine({
    validation: args.includes('--validation'),
    application: 'FdwEngine demo',
  });
  await vulkanEngine.init();
  engine = vulkanEngine;
  title = `FdwEngine: ${name} (Vulkan, ${vulkanEngine.device?.name})`;
  window = new NativeWindow({
    title,
    width: 1280,
    height: 720,
    hidden: args.includes('--hidden'),
    vulkan: true,
  });
  // The swapchain sets the pace: no throttle.
  surface = new VulkanWindowSurface(window, { vsync });
} else if (d3d12) {
  const d3d12Engine = new D3D12Engine({
    validation: args.includes('--validation'),
    application: 'FdwEngine demo',
  });
  await d3d12Engine.init();
  engine = d3d12Engine;
  title = `FdwEngine: ${name} (Direct3D 12, ${d3d12Engine.device?.name})`;
  window = new NativeWindow({
    title,
    width: 1280,
    height: 720,
    hidden: args.includes('--hidden'),
  });
  // The swapchain sets the pace: no throttle.
  surface = new D3D12WindowSurface(window, { vsync });
} else {
  engine = await createDawnEngine();
  title = `FdwEngine: ${name} (WebGPU, Dawn)`;
  window = new NativeWindow({
    title,
    width: 1280,
    height: 720,
    hidden: args.includes('--hidden'),
  });
  const dawnSurface = new DawnWindowSurface(window);
  window.vsync = vsync;
  throttle = () => dawnSurface.throttle();
  surface = dawnSurface;
}
await surface.init(engine);
const backend = engine.backend;
if (!backend) {
  throw new Error('The engine is not ready');
}
// The information of the scene, shown in the title with the frame rate.
let info = '';
const factory = scenes[name] ?? (await loadedScenes[name]());
const audio = args.includes('--no-audio') ? undefined : new NativeAudioEngine();
const scene = factory(backend, surface, {
  input: new NativeInputSource(window),
  audio,
  info: (text) => {
    info = text;
  },
});

const start = performance.now();
let frames = 0;
let second = start;
let framesThisSecond = 0;
const loop = runLoop(
  (now) => {
    scene.frame((now - start) / 1000);
    frames++;
    framesThisSecond++;
    if (now - second >= 1000) {
      window.title = `${title}, ${framesThisSecond} fps, ${window.width} × ${
        window.height
      }${info ? `, ${info}` : ''}`;
      second = now;
      framesThisSecond = 0;
    }
    if (frames >= maxFrames) {
      loop.stop();
    }
  },
  throttle ? { throttle } : {},
);
window.addEventListener('close', () => loop.stop());
window.addEventListener('keydown', (event) => {
  if ((event as NativeWindowEvent).key === 'Escape') {
    loop.stop();
  }
});

await loop.done;
const seconds = (performance.now() - start) / 1000;
console.log(
  `${name}: ${frames} frames in ${seconds.toFixed(1)} s (${(
    frames / seconds
  ).toFixed(1)} fps)${info ? `, ${info}` : ''}`,
);
if (engine instanceof VulkanEngine) {
  const messages = engine.device?.takeMessages() ?? [];
  if (messages.length > 0) {
    console.log(`Vulkan validation:\n${messages.join('\n')}`);
  }
}
if (engine instanceof D3D12Engine) {
  const messages = engine.device?.takeMessages() ?? [];
  if (messages.length > 0) {
    console.log(`Direct3D 12 debug layer:\n${messages.join('\n')}`);
  }
}
scene.destroy();
audio?.destroy();
await throttle?.();
surface.destroy();
window.destroy();
await engine.destroy();
