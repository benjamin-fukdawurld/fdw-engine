import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createCoastScene } from '@fdw/demo-scenes';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

// The coast: the sea of an ocean spectrum and what floats on it, on Rapier
// loaded (WebAssembly) before the route.
function CoastRoute() {
  const engine = Route.useLoaderData();
  const scene = useMemo(() => createCoastScene(engine), [engine]);
  return <SceneLayout scene={scene} />;
}

export const Route = createFileRoute('/coast')({
  loader: () => createRapierPhysics(),
  component: CoastRoute,
});
