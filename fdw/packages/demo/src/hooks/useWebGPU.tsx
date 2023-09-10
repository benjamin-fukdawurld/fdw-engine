import { useEffect, useState, useRef, MutableRefObject } from 'react';

import Gpu from '../engine/Gpu';
import Surface from '../engine/Surface';

export type WebGPUProps = {
  canvas: MutableRefObject<HTMLCanvasElement | null>;
  label?: string;
};

export function useWebGPU({ canvas, label }: WebGPUProps) {
  const gpu = useRef<Gpu | null>(null);
  const surface = useRef<Surface | null>(null);
  const [gpuReady, setGpuReady] = useState<boolean>(false);

  const init = async (canvas: HTMLCanvasElement) => {
    gpu.current = new Gpu(label);
    surface.current = new Surface(canvas);

    await gpu.current.init();
    await surface.current.init(gpu.current);

    setGpuReady(true);
  };

  useEffect(() => {
    if (!canvas.current) {
      return;
    }

    init(canvas.current);
  }, []);

  return {
    gpu: gpu.current,
    surface: surface.current,
    gpuReady,
  };
}
