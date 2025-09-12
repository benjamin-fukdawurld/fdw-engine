import { createContext, useContext } from 'react';
import { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const SceneGraphContext = createContext<GLTF | null>(null);

export function useSceneGraph() {
  const context = useContext(SceneGraphContext);
  if (!context) {
    throw new Error('useSceneGraph must be used within a SceneGraphProvider');
  }

  return context;
}
