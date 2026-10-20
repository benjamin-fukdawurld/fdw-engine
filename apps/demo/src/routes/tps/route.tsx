import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createTpsScene, TpsLevelPath } from '@fdw/demo-scenes';
import { createRapierPhysics } from '@fdw/engine-physics-rapier';
import { demoResources } from '../../utils3d/resources';

// The third-person game in the forest, on Rapier, loaded (WebAssembly)
// before the route; the models and the level load with the scene.
function TpsRoute() {
  const physics = Route.useLoaderData();
  const scene = useMemo(
    () =>
      createTpsScene({
        physics,
        resources: demoResources,
        level: TpsLevelPath,
      }),
    [physics],
  );
  return <SceneLayout scene={scene} />;
}

export const Route = createFileRoute('/tps')({
  loader: () => createRapierPhysics(),
  component: TpsRoute,
});
