import { Gpu, Program, Surface } from '@fdw/render';

async function start() {
  const canvas = document.getElementById(
    'main-canvas'
  ) as HTMLCanvasElement | null;

  if (!canvas) {
    throw new Error('Canvas cannot be found');
  }

  const gpu = new Gpu('default');
  const surface = new Surface(canvas);

  await gpu.init();
  await surface.init(gpu);
}

start();
