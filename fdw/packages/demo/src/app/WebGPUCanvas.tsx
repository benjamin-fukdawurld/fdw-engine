import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebGPU, useProgram } from '../hooks';

import hardcodedShader from '../assets/hardcoded.wgsl?raw';
import Gpu from '../engine/Gpu';
import Surface from '../engine/Surface';
import Program from '../engine/Program';

export function WebGPUCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { gpu, surface, gpuReady } = useWebGPU({
    canvas: canvasRef,
    label: 'default',
  });
  const { programReady, render } = useProgram({
    gpu,
    surface,
    gpuReady,
    shaderCode: hardcodedShader,
    renderPass: (gpu: Gpu, surface: Surface, program: Program) => {
      return () => {
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

        const pass = program.encoder.beginRenderPass(renderPassDescriptor);
        pass.setPipeline(program.pipeline);
        pass.draw(3);
        pass.end();

        const commandBuffer = program.encoder.finish();
        gpu.device.queue.submit([commandBuffer]);
      };
    },
  });

  useEffect(() => {
    if (!programReady || !render) {
      return;
    }

    render();
  }, [programReady]);

  return (
    <canvas
      style={{
        width: '100%',
      }}
      ref={canvasRef}
    ></canvas>
  );
}

export default WebGPUCanvas;
