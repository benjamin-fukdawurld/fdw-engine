import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createSsrScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/ssr')({
  component: () => <SceneLayout scene={createSsrScene} />,
});
