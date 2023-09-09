import { useMachine } from '@xstate/react';
import { useEffect, MutableRefObject } from 'react';

import { RenderDeviceMachine } from '../machines/RenderDeviceMachine';

export function useWebGPU({
  canvas,
  label,
}: {
  canvas: MutableRefObject<HTMLCanvasElement | null>;
  label?: string;
}) {
  const [state, send] = useMachine(RenderDeviceMachine);
  const init = async () => {
    if (canvas.current === null || state.value !== 'notInitialized') {
      return;
    }

    canvas.current.width = canvas.current.offsetWidth;
    canvas.current.height = canvas.current.offsetHeight;

    const adapter = (await navigator.gpu?.requestAdapter()) ?? null;
    if (!adapter) {
      send({
        type: 'Init failed',
        errorMessage: 'browser does not support WebGPU',
      });
      throw new Error('browser does not support WebGPU');
    }

    send({ type: 'Adapter ready', adapter });

    const device =
      (await adapter?.requestDevice({
        label: `${label ?? 'untitled'} device`,
      })) ?? null;
    if (!device) {
      send({
        type: 'Init failed',
        errorMessage: 'browser does not support WebGPU',
      });
      throw new Error('browser does not support WebGPU');
    }

    send({ type: 'Device ready', device });

    const context = canvas.current?.getContext('webgpu') ?? null;
    if (!context) {
      send({
        type: 'Init failed',
        errorMessage: 'browser does not support WebGPU',
      });
      throw new Error('canvas does not support WebGPU');
    }

    send({ type: 'Context ready', context });

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
    });

    send({ type: 'Device configured', format });
  };

  useEffect(() => {
    init();
  }, []);

  return state;
}
