import { Gpu, Program, Surface } from '@fdw/render';

import shaderCode from './assets/hardcoded.wgsl?raw';

async function start() {
  const canvas = document.getElementById(
    'main-canvas'
  ) as HTMLCanvasElement | null;

  if (!canvas) {
    throw new Error('Canvas cannot be found');
  }

  const gpu = new Gpu('default');
  const surface = new Surface(canvas);
  const program = new Program();

  await gpu.init();
  await surface.init(gpu);
  await program.init(gpu, {
    shaderDescriptor: () => ({
      label: `shaders`,
      code: shaderCode,
    }),
    pipelineDescriptor: (shaderModule: GPUShaderModule) => ({
      label: `pipeline`,
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [{ format: surface.format }],
      },
    }),
  });

  const generateRenderPassDescriptor = (): GPURenderPassDescriptor => ({
    label: 'our basic canvas renderPass',
    colorAttachments: [
      {
        view: surface.context.getCurrentTexture().createView(),
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });

  const render = () => {
    const renderPassDescriptor = generateRenderPassDescriptor();
    const encoder = gpu.createCommandEncoder({ label: 'command-encoder' });

    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(program.pipeline);
    pass.draw(3);
    pass.end();

    const commandBuffer = encoder.finish();
    gpu.device.queue.submit([commandBuffer]);
  };

  surface.onResize = render;
}

start();
