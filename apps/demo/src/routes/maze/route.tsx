import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createMazeStep4 } from '@fdw/demo-scenes';

export const Route = createFileRoute('/maze')({
  component: () => <SceneLayout scene={createMazeStep4} />,
});
