import { WebGpuEngine } from '@fdw/engine-webgpu';

/**
 * A WebGPU engine on Dawn in Node (the `webgpu` package): its GPU objects
 * and constants (GPUBufferUsage…) become globals, as in a browser.
 */
export async function createDawnEngine(
  options: readonly string[] = [],
): Promise<WebGpuEngine> {
  const dawn = await import('webgpu');
  Object.assign(globalThis, dawn.globals);
  const engine = new WebGpuEngine({ gpu: dawn.create([...options]) });
  await engine.init();
  return engine;
}
