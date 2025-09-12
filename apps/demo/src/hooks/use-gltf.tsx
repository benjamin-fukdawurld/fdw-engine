import { useEffect, useState } from 'react';
import { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export function useGltf(url: string) {
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!url) return;

    const loader = new GLTFLoader();
    setLoading(true);
    loader.load(
      url,
      (gltf) => {
        setGltf(gltf);
        setLoading(false);
      },
      undefined,
      (err) => {
        setError(err);
        setLoading(false);
      }
    );
  }, [url]);

  return { gltf, error, loading };
}
