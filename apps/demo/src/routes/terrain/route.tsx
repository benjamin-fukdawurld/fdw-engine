import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createTerrainScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/terrain')({
  component: () => <SceneLayout scene={createTerrainScene} />,
});
