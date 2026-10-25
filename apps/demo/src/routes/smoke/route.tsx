import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createSmokeScene } from '@fdw/demo-scenes';

// Smoke and fire rising around a ball, in a grid of cells on the GPU.
const scene = createSmokeScene();

export const Route = createFileRoute('/smoke')({
  component: () => <SceneLayout scene={scene} />,
});
