import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createPbrScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/pbr')({
  component: () => <SceneLayout scene={createPbrScene} />,
});
