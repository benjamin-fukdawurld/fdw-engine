import {
  MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useWebGPU } from '../hooks';

import hardcodedShader from '../assets/hardcoded.wgsl?raw';

export function useRenderPipeline({
  canvas,
  shaders,
  label,
}: {
  canvas: MutableRefObject<HTMLCanvasElement | null>;
  label?: string;
  shaders: string;
}) {
  const state = useWebGPU({ canvas, label: 'default' });
  const shaderModuleRef = useRef<GPUShaderModule | null>(null);
  const pipelineRef = useRef<GPURenderPipeline | null>(null);
  const encoderRef = useRef<GPUCommandEncoder | null>(null);
  const [pipelineReady, setPipelineReady] = useState<boolean>(false);

  useEffect(() => {
    const { device, format } = state.context;
    if (
      state.value !== 'ready' ||
      !state.context.device ||
      !state.context.format
    ) {
      return;
    }

    shaderModuleRef.current = state.context.device.createShaderModule({
      label: `${label ?? 'untitled'} shaders`,
      code: shaders,
    });

    pipelineRef.current = state.context.device.createRenderPipeline({
      label: `${label ?? 'untitled'} pipeline`,
      layout: 'auto',
      vertex: {
        module: shaderModuleRef.current,
        entryPoint: 'vs',
      },
      fragment: {
        module: shaderModuleRef.current,
        entryPoint: 'fs',
        targets: [{ format: state.context.format }],
      },
    });

    encoderRef.current = state.context.device.createCommandEncoder({
      label: 'hardcoded encoder',
    });

    setPipelineReady(true);
  }, [state]);

  return {
    shaderModule: shaderModuleRef.current,
    renderPipeline: pipelineRef.current,
    commandEncoder: encoderRef.current,
    pipelineReady,
  };
}

export function useRenderPass() {
  /* const render = useCallback(() => {
    const renderPassDescriptor: any = {
      label: 'our basic canvas renderPass',
      colorAttachments: [
        {
          view: context!.getCurrentTexture().createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const pass = commandEncoder!.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(renderPipeline!);
    pass.draw(3);
    pass.end();

    const commandBuffer = commandEncoder!.finish();
    device!.queue.submit([commandBuffer]);
  }, [pipelineReady]); */
}

export function WebGPUCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const state = useWebGPU({ canvas: canvasRef, label: 'default' });
  const { renderPipeline, commandEncoder, pipelineReady } = useRenderPipeline({
    canvas: canvasRef,
    shaders: hardcodedShader,
    label: 'hardcoded red triangle',
  });

  const render = useCallback(() => {
    const renderPassDescriptor: any = {
      label: 'our basic canvas renderPass',
      colorAttachments: [
        {
          view: state.context.context!.getCurrentTexture().createView(),
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    };

    const pass = commandEncoder!.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(renderPipeline!);
    pass.draw(3);
    pass.end();

    const commandBuffer = commandEncoder!.finish();
    state.context.device!.queue.submit([commandBuffer]);
  }, [pipelineReady]);

  useEffect(() => {
    if (state.value !== 'ready' || !pipelineReady) {
      return;
    }

    render();
  }, [state, pipelineReady]);

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
