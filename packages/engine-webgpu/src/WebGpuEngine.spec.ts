import { describe, expect, it, vi } from 'vitest';
import { WebGpuDeviceLost, WebGpuEngine } from './WebGpuEngine';

// A fake device: lost when destroyed, or by lose().
function fakeDevice() {
  let lose: (info: GPUDeviceLostInfo) => void = () => undefined;
  const events = new EventTarget();
  const device = {
    features: new Set<string>(),
    limits: {},
    lost: new Promise<GPUDeviceLostInfo>((resolve) => (lose = resolve)),
    destroyed: false,
    destroy() {
      device.destroyed = true;
      lose({ reason: 'destroyed', message: '' } as GPUDeviceLostInfo);
    },
    addEventListener: events.addEventListener.bind(events),
    // Raises an error no scope caught.
    raise(message: string) {
      events.dispatchEvent(
        Object.assign(new Event('uncapturederror'), { error: { message } }),
      );
    },
    lose: (message: string) =>
      lose({ reason: 'unknown', message } as GPUDeviceLostInfo),
  };
  return device;
}

// A fake entry point, whose device is given when release() is called.
function fakeGpu() {
  const devices: ReturnType<typeof fakeDevice>[] = [];
  let release: () => void = () => undefined;
  const gpu = {
    requestAdapter: async () => ({
      features: new Set<string>(),
      limits: {},
      requestDevice: () =>
        new Promise((resolve) => {
          release = () => {
            const device = fakeDevice();
            devices.push(device);
            resolve(device);
          };
        }),
    }),
    getPreferredCanvasFormat: () => 'rgba8unorm',
  };
  return {
    gpu: gpu as unknown as GPU,
    devices,
    release: async () => {
      // The adapter first.
      await new Promise((resolve) => setTimeout(resolve));
      release();
    },
  };
}

describe('WebGpuEngine', () => {
  it('reports the loss of the device, not its destruction', async () => {
    const { gpu, devices, release } = fakeGpu();
    const engine = new WebGpuEngine({ gpu });
    const initialized = engine.init();
    await release();
    await initialized;
    expect(engine.state.value).toBe('ready');
    expect(engine.gpu).toBe(gpu);

    const lost: WebGpuDeviceLost[] = [];
    engine.addEventListener('lost', (event) =>
      lost.push((event as CustomEvent<WebGpuDeviceLost>).detail),
    );
    devices[0].lose('GPU reset');
    await Promise.resolve();
    expect(engine.lost).toBe(true);
    expect(lost).toEqual([{ engine, reason: 'unknown', message: 'GPU reset' }]);

    // Initialized again: a new device, whose destruction is not reported.
    await engine.destroy();
    const again = engine.init();
    await release();
    await again;
    expect(engine.lost).toBe(false);
    await engine.destroy();
    await Promise.resolve();
    expect(lost).toHaveLength(1);
  });

  it('dispatches the errors no scope caught, logged if not handled', async () => {
    const { gpu, devices, release } = fakeGpu();
    const engine = new WebGpuEngine({ gpu });
    const initialized = engine.init();
    await release();
    await initialized;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      devices[0].raise('invalid buffer');
      expect(log).toHaveBeenCalledWith('WebGPU: invalid buffer');
      const errors: string[] = [];
      engine.addEventListener('error', (event) => {
        errors.push((event as CustomEvent<GPUError>).detail.message);
        event.preventDefault();
      });
      devices[0].raise('invalid texture');
      expect(errors).toEqual(['invalid texture']);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('drops the device of an initialization overtaken by destroy()', async () => {
    const { gpu, devices, release } = fakeGpu();
    const engine = new WebGpuEngine({ gpu });
    const initialized = engine.init();
    await engine.destroy();
    await release();
    await expect(initialized).rejects.toThrow(/destroyed during/);
    expect(engine.state.value).toBe('destroyed');
    expect(engine.device).toBeUndefined();
    expect(engine.backend).toBeUndefined();
    expect(devices[0].destroyed).toBe(true);
  });
});
