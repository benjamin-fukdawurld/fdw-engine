import Layout from '../components/Layout';
import { useGltf } from '../hooks/use-gltf';

import { LoaderCircle } from 'lucide-react';
import { SceneGraphContext } from '../hooks/useSceneGraph';

export function App() {
  const { gltf, loading } = useGltf('/Box.glb');

  if (loading) {
    return (
      <div className="w-vw h-svh flex items-center justify-center bg-black/50">
        <LoaderCircle className="animate-spin stroke-white/75" />
      </div>
    );
  }

  return (
    <SceneGraphContext value={gltf}>
      <Layout>Hello world!</Layout>
    </SceneGraphContext>
  );
}

export default App;
