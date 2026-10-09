import { useEffect, useRef } from 'react';
import { Engine, Surface } from '@fdw/engine-backend';
import Layout from './Layout';
import type { Scene, SceneFactory } from '@fdw/demo-scenes';

// A route showing a scene of @fdw/demo-scenes, rendered every animation frame on
// any backend.
export default function SceneLayout({ scene }: { scene: SceneFactory }) {
  const frameRef = useRef<number | undefined>(undefined);
  const sceneRef = useRef<Scene | undefined>(undefined);

  // Stop rendering when leaving the route.
  useEffect(
    () => () => {
      if (frameRef.current !== undefined) {
        cancelAnimationFrame(frameRef.current);
      }
      sceneRef.current?.destroy();
    },
    []
  );

  const onSurfaceReady = async (engine: Engine, surface: Surface) => {
    const backend = engine.backend;
    if (!backend) {
      throw new Error('The engine is not ready');
    }
    const created = scene(backend, surface);
    sceneRef.current = created;
    const start = performance.now();
    const frame = () => {
      created.frame((performance.now() - start) / 1000);
      frameRef.current = requestAnimationFrame(frame);
    };
    frameRef.current = requestAnimationFrame(frame);
  };

  return <Layout onSurfaceReady={onSurfaceReady} portable />;
}
