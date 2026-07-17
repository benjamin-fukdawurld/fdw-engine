import { memo, useLayoutEffect, useRef, useState } from 'react';

type BaseProps = {
  onReady?: (canvas: HTMLCanvasElement) => void;
  onResize?: (canvas: HTMLCanvasElement) => void;
};

type Props = BaseProps &
  (
    | {
        width: number;
        height: number;
      }
    | {
        width?: never;
        height?: never;
      }
  );

const RenderSurface = memo(({ width, height, onReady, onResize }: Props) => {
  const [ready, setReady] = useState<boolean>(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    if (ready) {
      return;
    }

    if (!canvasRef.current) {
      return;
    }

    onReady?.(canvasRef.current);
    setReady(true);

    let resizeObserver: ResizeObserver | undefined;

    if (!width || !height) {
      canvasRef.current.width = canvasRef.current.clientWidth;
      canvasRef.current.height = canvasRef.current.clientHeight;

      resizeObserver = new ResizeObserver(() => {
        if (canvasRef.current) {
          canvasRef.current.width = canvasRef.current.clientWidth;
          canvasRef.current.height = canvasRef.current.clientHeight;
          onResize?.(canvasRef.current);
        }
      });

      resizeObserver.observe(canvasRef.current);
    }

    return () => {
      resizeObserver?.disconnect();
    };
  }, [onReady, ready]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="w-full h-full object-cover"
    ></canvas>
  );
});

export default RenderSurface;
