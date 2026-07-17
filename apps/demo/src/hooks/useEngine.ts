import { Engine } from '@fdw/engine-backend';
import { useEffect, useState } from 'react';
import { useSignals } from '@preact/signals-react/runtime';
import { getEngine } from '../globals/engine';

export type useEngineResult = {
  engine: Engine | null;
  isEngineLoading: boolean;
  engineError: Error | null;
};

export function useEngine(): useEngineResult {
  useSignals();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [isEngineLoading, setIsEngineLoading] = useState<boolean>(true);
  const [engineError, setEngineError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    getEngine()
      .then(async (engine) => {
        if (!mounted) {
          return;
        }

        setEngine(engine);
        setIsEngineLoading(false);
      })
      .catch((err) => {
        if (!mounted) {
          return;
        }
        console.error('Failed to initialize engine:', err);
        setEngineError(err);
        setIsEngineLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return {
    engine,
    isEngineLoading,
    engineError,
  };
}
