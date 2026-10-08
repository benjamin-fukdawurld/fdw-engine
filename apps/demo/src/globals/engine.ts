import { Engine } from '@fdw/engine-backend';
import { WebGpuEngine } from '@fdw/engine-webgpu';
import { WebGl2Engine } from '@fdw/engine-webgl2';
import { getBackendName } from './backend';

let instance: Engine | null = null;
let initializationPromise: Promise<Engine> | null = null;

export async function createEngine() {
  if (instance) {
    throw new Error('Engine instance already exists');
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    instance =
      getBackendName() === 'webgl2' ? new WebGl2Engine() : new WebGpuEngine();

    await instance.init();

    console.log('Engine initialized');
    return instance;
  })();

  return initializationPromise;
}

export async function getEngine() {
  if (!instance) {
    await createEngine();
  }

  return instance;
}

export async function destroyEngine() {
  if (!instance) {
    throw new Error('Engine instance not created yet');
  }
  instance.destroy();
  instance = null;
  initializationPromise = null;
}
