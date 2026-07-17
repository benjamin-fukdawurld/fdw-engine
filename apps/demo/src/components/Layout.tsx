import Header from '../components/Header';
import RenderSurface from '../components/RenderSurface';
import Footer from '../components/Footer';
import { useEffect } from 'react';
import { useEngine } from '../hooks/useEngine';
import { useSurface } from '../hooks/useSurface';
import { Engine, Surface } from '@fdw/engine-backend';

type Props = {
  children?: React.ReactNode;
  onSurfaceReady?: (
    engine: Engine,
    surface: Surface,
    canvas: HTMLCanvasElement
  ) => Promise<void>;
};

export default function Layout({ children, onSurfaceReady }: Props) {
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
