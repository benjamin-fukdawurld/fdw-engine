import { createFileRoute } from '@tanstack/react-router';
import SceneLayout from '../../components/SceneLayout';
import { createDeferredScene } from '@fdw/demo-scenes';

// The pointer over the canvas: the scene picks the pixel under it.
export const Route = createFileRoute('/deferred')({
  component: () => (
    <SceneLayout scene={createDeferredScene} inputOver="canvas" />
  ),
});
