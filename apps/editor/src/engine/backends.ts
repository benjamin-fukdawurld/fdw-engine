import type { Engine, RenderBackend, Surface } from '@fdw/engine-backend';
import { D3D12Engine } from '@fdw/engine-d3d12';
import { createDawnEngine, DawnWindowSurface } from '@fdw/engine-native';
import { FileShaderCache, VulkanEngine } from '@fdw/engine-vulkan';
import { ViewportSurface } from './ViewportSurface';
import type { NativeViewport } from './viewport';

/** A backend started on the viewport, with its surface. */
export interface Renderer {
  readonly backend: RenderBackend;
  readonly device: string;
  readonly surface: Surface;
  waitIdle(): void;
  nextFrame(): Promise<void>;
  /** After the scene: the surface, then the engine. */
  destroy(): Promise<void>;
}

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

// Destroys what was made before a backend failed to start.
async function startOrClean<T>(
  start: () => Promise<T>,
  clean: () => Promise<void>,
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    await clean().catch(() => undefined);
    throw error;
  }
}

/**
 * Vulkan, presenting into the viewport with a swapchain, without copy:
 * created here, so that a missing addon, a missing device or a swapchain
 * the window refuses all mean the fallback. FIFO: the swapchain sets the
 * pace.
 */
export async function startVulkan(viewport: NativeViewport): Promise<Renderer> {
  const engine = new VulkanEngine({
    application: 'FDW Editor',
    validation: process.env['FDW_VALIDATION'] === '1',
    // The programs compiled at a previous start (FDW_SHADER_CACHE=off:
    // none).
    shaderCache: FileShaderCache.fromEnvironment(),
  });
  const surface = new ViewportSurface(viewport);
  const destroy = async () => {
    const messages = engine.device?.takeMessages() ?? [];
    if (messages.length > 0) {
      console.log(`[engine] Vulkan validation:\n${messages.join('\n')}`);
    }
    surface.destroy();
    await engine.destroy();
  };
  return startOrClean(async () => {
    await engine.init();
    const { backend, device } = engine;
    if (!backend || !device) throw new Error('The Vulkan engine is not ready');
    await surface.init(engine);
    return {
      backend,
      device: device.name,
      surface,
      waitIdle: () => device.waitIdle(),
      nextFrame: nextTask,
      destroy,
    };
  }, destroy);
}

/**
 * Direct3D 12 (FDW_BACKEND=d3d12, Windows), presenting into the viewport
 * with a DXGI swapchain, without copy, as Vulkan does.
 */
export async function startD3D12(viewport: NativeViewport): Promise<Renderer> {
  const engine = new D3D12Engine({
    application: 'FDW Editor',
    validation: process.env['FDW_VALIDATION'] === '1',
    shaderCache: FileShaderCache.fromEnvironment(),
  });
  const surface = new ViewportSurface(viewport);
  const destroy = async () => {
    const messages = engine.device?.takeMessages() ?? [];
    if (messages.length > 0) {
      console.log(`[engine] Direct3D 12 debug layer:\n${messages.join('\n')}`);
    }
    surface.destroy();
    await engine.destroy();
  };
  return startOrClean(async () => {
    await engine.init();
    const { backend, device } = engine;
    if (!backend || !device) {
      throw new Error('The Direct3D 12 engine is not ready');
    }
    await surface.init(engine);
    return {
      backend,
      device: device.name,
      surface,
      waitIdle: () => device.waitIdle(),
      nextFrame: nextTask,
      destroy,
    };
  }, destroy);
}

// The pace of Dawn's frames: the copy into the window has no vertical
// synchronization.
const dawnInterval = 1000 / 60;

/**
 * WebGPU on Dawn (the `webgpu` package), the fallback: dawn.node does not
 * present into a window, so each frame is read back and copied into the
 * viewport by its addon (DawnWindowSurface). About 500 MB/s in 1080p at
 * 60 Hz.
 */
export async function startDawn(viewport: NativeViewport): Promise<Renderer> {
  let engine: Engine | undefined;
  const surface = new DawnWindowSurface(viewport);
  const destroy = async () => {
    surface.destroy();
    await engine?.destroy();
  };
  return startOrClean(async () => {
    const dawn = await createDawnEngine();
    engine = dawn;
    const { backend, adapter } = dawn;
    if (!backend) throw new Error('The Dawn engine is not ready');
    await surface.init(dawn);
    let last = performance.now();
    return {
      backend,
      device: adapter?.info.device || adapter?.info.description || 'Dawn',
      surface,
      // WebGPU keeps the resources of the frames in flight alive itself.
      waitIdle: () => undefined,
      nextFrame: async () => {
        await surface.throttle();
        const wait = last + dawnInterval - performance.now();
        if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
        else await nextTask();
        last = performance.now();
      },
      destroy,
    };
  }, destroy);
}
