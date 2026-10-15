import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createFpsScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/fps')({
  component: () => <SceneLayout scene={createFpsScene} />,
});
