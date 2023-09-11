import Gpu from '../engine/Gpu';
import Surface from '../engine/Surface';

import hardcodedShader from '../assets/hardcoded.wgsl?raw';
import Program from '../engine/Program';

export async function main(canvas: HTMLCanvasElement) {
  const label = 'WebGPU-test';

  const gpu = new Gpu(label);
  const surface = new Surface(canvas);

  await gpu.init();
  await surface.init(gpu);

  const { format } = surface;

  const program = new Program();
  await program.init(gpu, {
    shaderDescriptor: () => ({
      label: `shaders`,
      code: hardcodedShader,
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
        targets: [{ format }],
      },
    }),
  });

  const render = () => {
    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: 'our basic canvas renderPass',
      colorAttachments: [
        {
          view: surface.context.getCurrentTexture().createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const encoder = gpu.createCommandEncoder();

    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(program.pipeline);
    pass.draw(3);
    pass.end();

    const commandBuffer = encoder.finish();
    gpu.device.queue.submit([commandBuffer]);
  };

  surface.onResize = render;
}
