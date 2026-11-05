// The measures of the GPU-driven rendering (design/p24-gpu-driven.md §6):
// the GPU time of the passes of the culling on the GPU, by timestamps, for
// the city of P3 grown to about 10 000 and 100 000 buildings, seen from its
// avenue in 1920 × 1080, on the Vulkan of this machine (its GPU, without
// the validation layer). Compared: the culling on the CPU with the
// occlusion culling by readback (P3), the culling on the GPU with the
// occlusion culling in two phases, and the same with the buildings kept on
// the GPU (a GpuScene, step 7).
//
// Usage (needs the Vulkan addon, built by nx run engine-vulkan:build-native):
//   node --import @swc-node/register/esm-register \
//     --conditions=@fdw-engine/source tools/bench/gpu-driven.ts [frames]
import {
  AllLayers,
  Camera,
  GpuScene,
  Renderable,
  RenderGraph,
  RenderGraphRunner,
  Renderer,
} from '@fdw/engine-core';
import { buildCity } from '@fdw/demo-scenes';
import { OcclusionCulling } from '@fdw/engine-occlusion';
import { Frustum } from '@fdw/engine-geometry';
import { Scene } from '@fdw/engine-scene';
import { VulkanEngine, VulkanOffscreenSurface } from '@fdw/engine-vulkan';

const frames = Number(process.argv[2] ?? 60);
const width = 1920;
const height = 1080;

// Blocks of 3 × 3 buildings: 33² × 9 = 9801, 105² × 9 = 99 225.
const cities = (process.env.FDW_CITY_BLOCKS ?? '33,105').split(',').map(Number);

const engine = new VulkanEngine({ validation: false, application: 'measure' });
await engine.init();
const backend = engine.backend;
const device = engine.device;
if (!backend || !device) {
  throw new Error('No Vulkan device');
}
const surface = new VulkanOffscreenSurface(width, height);
await surface.init(engine);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

for (const blocks of cities) {
  const scene = new Scene();
  const city = buildCity(scene, { blocks, block: 42, street: 14 });
  const camera = new Camera({
    position: {
      x: city.streets[Math.floor(city.streets.length / 2)],
      y: 2,
      z: city.half * 0.5,
    },
    rotation: { x: Math.sin(0.04), y: 0, z: 0, w: Math.cos(0.04) },
    projection: {
      type: 'perspective',
      fov: 60,
      aspect: width / height,
      near: 0.5,
      far: 4000,
    },
  });
  // Every building, for the GpuScene: a frustum holding everything.
  const everything = new Frustum();
  for (let plane = 0; plane < 6; plane++) {
    everything.planes[plane * 4 + 3] = 1;
  }
  const buildings: Renderable[] = [];
  scene.query(everything, AllLayers, (item) => buildings.push(item), 'shadow');
  const gpuScene = new GpuScene();
  buildings.forEach((item) => gpuScene.add(item));
  for (const mode of ['cpu', 'gpu', 'gpu scene'] as const) {
    const renderer = new Renderer(backend);
    const runner = new RenderGraphRunner(backend, { timing: true });
    const occlusion = new OcclusionCulling();
    const times = new Map<string, number[]>();
    const cpu: number[] = [];
    let inView = 0;
    for (let frame = 0; frame < frames; frame++) {
      const start = performance.now();
      const graph = new RenderGraph({ size: { width, height } });
      const target = graph.importTexture('surface', surface.getCurrentTarget());
      renderer.addScenePasses(graph, {
        ...(mode === 'gpu scene' ? { gpuScene } : { source: scene }),
        camera,
        target,
        format: surface.format,
        shadows: false,
        occlusion,
        gpuCulling: mode !== 'cpu',
      });
      runner.execute(graph);
      cpu.push(performance.now() - start);
      // Lets the readbacks and the timestamps arrive.
      device.waitIdle();
      await new Promise((resolve) => setTimeout(resolve));
      inView = renderer.stats.get('scene')?.visible ?? 0;
      // The measures of the second half: the pipelines are made.
      if (frame >= frames / 2) {
        for (const [pass, ms] of runner.passTimes) {
          const list = times.get(pass) ?? [];
          list.push(ms);
          times.set(pass, list);
        }
      }
    }
    const stats = renderer.stats.get('scene');
    console.log(
      `\n${city.buildings.length} buildings, culling on the ${mode.toUpperCase()}: ` +
        `${inView} given to the passes (${stats?.occluded ?? 0} hidden by the CPU), ` +
        `CPU ${median(cpu.slice(frames / 2)).toFixed(2)} ms a frame`,
    );
    let total = 0;
    for (const [pass, list] of times) {
      const ms = median(list);
      total += ms;
      console.log(`  ${pass.padEnd(32)} ${ms.toFixed(3)} ms`);
    }
    console.log(`  ${'all the passes'.padEnd(32)} ${total.toFixed(3)} ms`);
    occlusion.destroy();
    runner.destroy();
    renderer.destroy();
  }
}

surface.destroy();
device.waitIdle();
await engine.destroy();
