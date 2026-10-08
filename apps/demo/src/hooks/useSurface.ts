import { Engine, Surface } from '@fdw/engine-backend';
import { WebGpuSurface } from '@fdw/engine-webgpu';
import { WebGl2CanvasSurface, WebGl2Engine } from '@fdw/engine-webgl2';
import { RefObject, useEffect, useRef, useState } from 'react';

export type useSurfaceResult = {
  surface: Surface | null;
  isSurfaceReady: boolean;
  surfaceError: Error | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onCanvasReady: (canvas: HTMLCanvasElement) => void;
};

export function useSurface(
  engine: Engine | null,
  engineError: Error | null
): useSurfaceResult {
  const [surface, setSurface] = useState<Surface | null>(null);
  const [canvasReady, setCanvasReady] = useState<boolean>(false);
  const [isSurfaceReady, setIsSurfaceReady] = useState<boolean>(false);
  const [surfaceError, setSurfaceError] = useState<Error | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const onCanvasReady = (canvas: HTMLCanvasElement) => {
    if (!canvas) {
      setSurfaceError(new Error('Canvas element is null'));
      return;
    }
    canvasRef.current = canvas;
    setCanvasReady(true);
  };

  useEffect(() => {
    if (
      !engine ||
      engineError ||
      engine.state.value !== 'ready' ||
      !canvasReady ||
      !canvasRef.current ||
      isSurfaceReady
    ) {
      return;
    }

    const surfaceInstance =
      engine instanceof WebGl2Engine
        ? new WebGl2CanvasSurface(canvasRef.current)
        : new WebGpuSurface(canvasRef.current);
    surfaceInstance
      .init(engine)
      .then(() => {
        setSurface(surfaceInstance);
        setIsSurfaceReady(true);
        console.log('Surface initialized');
      })
      .catch((err) => {
        console.error('Failed to initialize surface:', err);
        setSurfaceError(err);
      });
  }, [engine, engineError, canvasReady, engine?.state.value]);

  return {
    surface,
    isSurfaceReady,
    surfaceError,
    canvasRef,
    onCanvasReady,
  };
}
