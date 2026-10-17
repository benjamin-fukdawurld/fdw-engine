import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createPhysicsScene } from '@fdw/demo-scenes';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

// The physics playground on Rapier, loaded (WebAssembly) before the route.
function PhysicsRoute() {
  const engine = Route.useLoaderData();
  const scene = useMemo(() => createPhysicsScene(engine), [engine]);
  return <SceneLayout scene={scene} />;
}

export const Route = createFileRoute('/physics')({
  loader: () => createRapierPhysics(),
  component: PhysicsRoute,
});
