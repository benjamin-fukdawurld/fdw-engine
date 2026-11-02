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
  engineError: Error | null,
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

  // The surface made, released with the component.
  const surfaceRef = useRef<Surface | null>(null);

  useEffect(() => {
    if (
      !engine ||
      engineError ||
      engine.state.value !== 'ready' ||
      !canvasReady ||
      !canvasRef.current ||
      surfaceRef.current
    ) {
      return;
    }

    const surfaceInstance =
      engine instanceof WebGl2Engine
        ? new WebGl2CanvasSurface(canvasRef.current)
        : new WebGpuSurface(canvasRef.current);
    surfaceRef.current = surfaceInstance;
    surfaceInstance
      .init(engine)
      .then(() => {
        // Released meanwhile: the component is gone.
        if (surfaceRef.current !== surfaceInstance) return;
        setSurface(surfaceInstance);
        setIsSurfaceReady(true);
        console.log('Surface initialized');
      })
      .catch((err) => {
        if (surfaceRef.current !== surfaceInstance) return;
        console.error('Failed to initialize surface:', err);
        setSurfaceError(err);
      });
  }, [engine, engineError, canvasReady, engine?.state.value]);

  // Made again when mounted again (StrictMode).
  useEffect(
    () => () => {
      const released = surfaceRef.current;
      surfaceRef.current = null;
      if (released) releaseSurface(released);
      setSurface(null);
      setIsSurfaceReady(false);
    },
    [],
  );

  return {
    surface,
    isSurfaceReady,
    surfaceError,
    canvasRef,
    onCanvasReady,
  };
}

// What a surface holds: the configuration of the WebGPU context of its
// canvas, the framebuffer of a WebGL2 one.
function releaseSurface(surface: Surface): void {
  if (surface instanceof WebGpuSurface) {
    surface.context.unconfigure();
  } else if (surface instanceof WebGl2CanvasSurface) {
    surface.destroy();
  }
}
