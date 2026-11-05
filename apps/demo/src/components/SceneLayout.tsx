import { useCallback, useEffect, useRef, useState } from 'react';
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';
import { Engine, Surface } from '@fdw/engine-backend';
import { WebInputSource } from '@fdw/engine-input-web';
import Layout from './Layout';
import type { Scene, SceneFactory } from '@fdw/demo-scenes';

// A route showing a scene of @fdw/demo-scenes, rendered every animation frame on
// any backend. The scenes read the keyboard and the mouse of the window, the
// gamepads, play their sounds (from the first click or key: the browser
// wants a gesture), and show their information in a corner. With
// inputOver 'canvas', the pointer is read over the canvas instead (its
// position in fractions of the surface: for the scenes that pick a pixel),
// and the keys once the canvas has the focus; its context menu is off, for
// the right button.
export default function SceneLayout({
  scene,
  inputOver = 'window',
}: {
  scene: SceneFactory;
  inputOver?: 'window' | 'canvas';
}) {
  const frameRef = useRef<number | undefined>(undefined);
  const sceneRef = useRef<Scene | undefined>(undefined);
  const audioRef = useRef<{ engine: WebAudioEngine; unlock: () => void }>(
    undefined,
  );
  // The information of the scene, written at every frame, shown a few times
  // per second: a state changed at every frame would render the route at
  // every frame.
  const infoRef = useRef('');
  const [info, setInfo] = useState('');

  useEffect(() => {
    const interval = setInterval(() => setInfo(infoRef.current), 250);
    // Stop rendering when leaving the route.
    return () => {
      clearInterval(interval);
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
      sceneRef.current?.destroy();
      sceneRef.current = undefined;
      audioRef.current?.unlock();
      audioRef.current?.engine.destroy();
      audioRef.current = undefined;
    };
  }, []);

  // Stable: Layout calls it again whenever it changes.
  const onSurfaceReady = useCallback(
    async (engine: Engine, surface: Surface, canvas: HTMLCanvasElement) => {
      const backend = engine.backend;
      if (!backend) {
        throw new Error('The engine is not ready');
      }
      // One scene per surface, even if called again.
      if (sceneRef.current) {
        return;
      }
      const audio = new WebAudioEngine();
      // Stops listening for the gesture.
      audioRef.current = { engine: audio, unlock: unlockAudio(audio) };
      let inputTarget: HTMLElement | Window = window;
      if (inputOver === 'canvas') {
        inputTarget = canvas;
        canvas.tabIndex = 0;
        canvas.oncontextmenu = (event) => event.preventDefault();
        canvas.focus();
      }
      const created = scene(backend, surface, {
        input: new WebInputSource(inputTarget),
        audio,
        info: (text) => {
          infoRef.current = text;
        },
      });
      sceneRef.current = created;
      const start = performance.now();
      const frame = () => {
        created.frame((performance.now() - start) / 1000);
        frameRef.current = requestAnimationFrame(frame);
      };
      frameRef.current = requestAnimationFrame(frame);
    },
    [scene, inputOver],
  );

  return (
    <>
      <Layout onSurfaceReady={onSurfaceReady} portable />
      {info && (
        <div className="fixed bottom-4 right-4 rounded bg-black/60 px-3 py-1 text-sm text-white">
          {info}
        </div>
      )}
    </>
  );
}
