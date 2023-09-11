import { useLayoutEffect, useRef, useState } from 'react';
import { main } from './sample';

export function WebGPUCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState<boolean>(false);

  const init = async () => {
    if (ready || !canvasRef.current) {
      return;
    }

    setReady(true);
    main(canvasRef.current);
  };

  useLayoutEffect(() => {
    init();
  }, [ready]);

  return (
    <canvas
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
      }}
      ref={canvasRef}
    ></canvas>
  );
}

export default WebGPUCanvas;
