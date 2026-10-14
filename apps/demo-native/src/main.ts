// The demo scenes in a native window, outside of the browser (see
// design/native-backends.md):
// - WebGPU on Dawn, presented by copy (default);
// - Vulkan, presented by a swapchain (--vulkan), with the validation layer
//   when the Vulkan SDK is set up (--validation).
//
// nx run demo-native:start [-- <scene>] [--vulkan] [--validation]
//   [--no-vsync] [--frames <count>] [--hidden]
// Scenes: shadows (default), pbr, maze (maze-1 to maze-3 for its first steps),
// city (the occlusion culling; city-no-occlusion to compare).
// Escape or closing the window quits.
import type { Engine, Surface } from '@fdw/engine-backend';
import {
  createDawnEngine,
  DawnWindowSurface,
  NativeWindow,
  NativeWindowEvent,
  runLoop,
  VulkanWindowSurface,
} from '@fdw/engine-native';
import { NativeInputSource } from '@fdw/engine-input-native';
import { VulkanEngine } from '@fdw/engine-vulkan';
import {
  createCity,
  createCityScene,
  createMazeStep1,
  createMazeStep2,
  createMazeStep3,
  createMazeStep4,
  createPbrScene,
  createShadowsScene,
  SceneFactory,
} from '@fdw/demo-scenes';

const scenes: Record<string, SceneFactory> = {
  shadows: createShadowsScene,
  pbr: createPbrScene,
  // The game: its last step, and the steps before.
  maze: createMazeStep4,
  'maze-1': createMazeStep1,
  'maze-2': createMazeStep2,
  'maze-3': createMazeStep3,
  city: createCityScene,
  'city-no-occlusion': createCity({ occlusion: false }),
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const name =
  args.find((arg) => !arg.startsWith('--') && arg in scenes) ?? 'shadows';
// Stops after this many frames (tests, profiling).
const maxFrames = Number(option('--frames') ?? Infinity);
const vulkan = args.includes('--vulkan');
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
const scene = scenes[name](backend, surface, {
  input: new NativeInputSource(window),
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
  throttle ? { throttle } : {}
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
  ).toFixed(1)} fps)${info ? `, ${info}` : ''}`
);
if (engine instanceof VulkanEngine) {
  const messages = engine.device?.takeMessages() ?? [];
  if (messages.length > 0) {
    console.log(`Vulkan validation:\n${messages.join('\n')}`);
  }
}
scene.destroy();
await throttle?.();
surface.destroy();
window.destroy();
await engine.destroy();
