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
  // The last callback given, for the observer made once.
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useLayoutEffect(() => {
    if (ready || !canvasRef.current) {
      return;
    }
    onReady?.(canvasRef.current);
    setReady(true);
  }, [onReady, ready]);

  // Without a size, the canvas follows its box, for as long as it is shown.
  const sized = Boolean(width && height);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (sized || !canvas) {
      return;
    }
    const fit = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    };
    fit();
    const resizeObserver = new ResizeObserver(() => {
      fit();
      onResizeRef.current?.(canvas);
    });
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [sized]);

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
