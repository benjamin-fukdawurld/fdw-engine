import { useRef, useState, useEffect } from 'react';

import Gpu from '../engine/Gpu';
import Surface from '../engine/Surface';
import Program from '../engine/Program';

export type ProgramProps = {
  gpu: Gpu | null;
  surface: Surface | null;
  shaderCode: string;
  gpuReady: boolean;
  renderPass: (gpu: Gpu, surface: Surface, program: Program) => () => void;
};

export function useProgram({
  gpu,
  surface,
  shaderCode,
  gpuReady,
  renderPass,
}: ProgramProps) {
  const programRef = useRef<Program | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const [programReady, setProgramReady] = useState(false);

  const init = async () => {
    if (!gpuReady || !gpu || !surface) {
      return;
    }

    const { format } = surface;

    programRef.current = new Program();
    await programRef.current.init(gpu, {
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
          targets: [{ format }],
        },
      }),
      encoderDescriptor: () => ({
        label: 'hardcoded encoder',
      }),
    });

    renderRef.current = renderPass(gpu, surface, programRef.current);
    setProgramReady(true);
  };

  useEffect(() => {
    init();
  }, [gpuReady]);

  return {
    program: programRef.current,
    render: renderRef.current,
    programReady,
  };
}
