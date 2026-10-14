import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createCityScene } from '@fdw/demo-scenes';

export const Route = createFileRoute('/city')({
  component: () => <SceneLayout scene={createCityScene} />,
});
