import Header from '../components/Header';
import RenderSurface from '../components/RenderSurface';
import Footer from '../components/Footer';
import { useEffect } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useSurface } from '../hooks/useSurface';
import { Engine, Surface } from '@fdw/engine-backend';
import { backendLabels, getBackendName } from '../globals/backend';

type Props = {
  children?: React.ReactNode;
  onSurfaceReady?: (
    engine: Engine,
    surface: Surface,
    canvas: HTMLCanvasElement
  ) => Promise<void>;
  // The route only uses the engine API, and runs on every backend. Other
  // routes use WebGPU directly.
  portable?: boolean;
};

export default function Layout({ children, onSurfaceReady, portable }: Props) {
  const backend = getBackendName();
  if (!portable && backend !== 'webgpu') {
    return (
      <div className="h-full w-full flex flex-col">
        <Header />
        <main className="w-full bg-gray-100 flex-1 flex items-center justify-center text-gray-600">
          This demo uses the WebGPU API directly: it does not run on{' '}
          {backendLabels[backend]}.
        </main>
        <Footer />
      </div>
    );
  }
  return (
    <EngineLayout onSurfaceReady={onSurfaceReady}>{children}</EngineLayout>
  );
}

function EngineLayout({ children, onSurfaceReady }: Omit<Props, 'portable'>) {
  const { engine, engineError } = useEngine();
  const { surface, isSurfaceReady, surfaceError, canvasRef, onCanvasReady } =
    useSurface(engine, engineError);

  useEffect(() => {
    if (engineError) {
      console.error('Engine failed to initialize:', engineError);
      return;
    }
  }, [engineError]);

  useEffect(() => {
    if (surfaceError) {
      console.error('Surface failed to initialize:', surfaceError);
      return;
    }
    if (isSurfaceReady) {
      console.log('Surface is ready');
      onSurfaceReady?.(engine!, surface!, canvasRef.current!);
    }
  }, [isSurfaceReady, surfaceError, onSurfaceReady]);

  return (
    <div className="h-full w-full flex flex-col">
      <Header />
      <main className="w-full bg-gray-100 flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        <RenderSurface width={1240} height={720} onReady={onCanvasReady} />
        {children}
      </main>
      <Footer />
    </div>
  );
}
