import { Engine } from '@fdw/engine-backend';
import { WebGpuEngine } from '@fdw/engine-webgpu';
import { WebGl2Engine } from '@fdw/engine-webgl2';
import { getBackendName } from './backend';

// The engine of the page, shared by the routes: made once, given once
// initialized. Every caller waits for the same initialization.
let initialization: Promise<Engine> | null = null;

async function createEngine(): Promise<Engine> {
  const engine =
    getBackendName() === 'webgl2' ? new WebGl2Engine() : new WebGpuEngine();
  try {
    await engine.init();
  } catch (error) {
    // What the initialization made before failing.
    await engine.destroy().catch(() => undefined);
    throw error;
  }
  console.log('Engine initialized');
  return engine;
}

/** The engine of the page, initialized; tried again after a failure. */
export function getEngine(): Promise<Engine> {
  if (!initialization) {
    initialization = createEngine();
    initialization.catch(() => {
      initialization = null;
    });
  }
  return initialization;
}
