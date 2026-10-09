// The demo scenes in a native window, outside of the browser: WebGPU on
// Dawn, presented by copy (see design/native-backends.md).
//
// nx run demo-native:start [-- <scene>] [--frames <count>] [--hidden]
// Scenes: shadows (default), pbr. Escape or closing the window quits.
import {
  createDawnEngine,
  DawnWindowSurface,
  NativeWindow,
  NativeWindowEvent,
  runLoop,
} from '@fdw/engine-native';
import {
  createPbrScene,
  createShadowsScene,
  SceneFactory,
} from '@fdw/demo-scenes';

const scenes: Record<string, SceneFactory> = {
  shadows: createShadowsScene,
  pbr: createPbrScene,
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

const engine = await createDawnEngine();
const title = `FdwEngine: ${name} (WebGPU, Dawn)`;
const window = new NativeWindow({
  title,
  width: 1280,
  height: 720,
  hidden: args.includes('--hidden'),
});
const surface = new DawnWindowSurface(window);
await surface.init(engine);
const backend = engine.backend;
if (!backend) {
  throw new Error('The engine is not ready');
}
const scene = scenes[name](backend, surface);

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
      window.title = `${title}, ${framesThisSecond} fps, ${window.width} × ${window.height}`;
      second = now;
      framesThisSecond = 0;
    }
    if (frames >= maxFrames) {
      loop.stop();
    }
  },
  { throttle: () => surface.throttle() }
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
  ).toFixed(1)} fps)`
);
scene.destroy();
await surface.throttle();
surface.destroy();
window.destroy();
await engine.destroy();
