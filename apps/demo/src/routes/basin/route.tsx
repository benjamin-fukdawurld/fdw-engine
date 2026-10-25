import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createBasinScene } from '@fdw/demo-scenes';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';

// The basin: a pond fed by a stream, its water a field of heights on the
// GPU, crates and balls floating on it, on Rapier loaded (WebAssembly)
// before the route.
function BasinRoute() {
  const engine = Route.useLoaderData();
  const scene = useMemo(() => createBasinScene(engine), [engine]);
  return <SceneLayout scene={scene} />;
}

export const Route = createFileRoute('/basin')({
  loader: () => createRapierPhysics(),
  component: BasinRoute,
});
