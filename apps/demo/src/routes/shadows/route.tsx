import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createShadowsScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/shadows')({
  component: () => <SceneLayout scene={createShadowsScene} />,
});
