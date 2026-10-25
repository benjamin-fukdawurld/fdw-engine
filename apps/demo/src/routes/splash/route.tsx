import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createSplashScene } from '@fdw/demo-scenes';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

// The tank: water made of particles on the GPU, a dam that breaks, crates
// floating in it, on Rapier loaded (WebAssembly) before the route.
function SplashRoute() {
  const engine = Route.useLoaderData();
  const scene = useMemo(() => createSplashScene(engine), [engine]);
  return <SceneLayout scene={scene} />;
}

export const Route = createFileRoute('/splash')({
  loader: () => createRapierPhysics(),
  component: SplashRoute,
});
