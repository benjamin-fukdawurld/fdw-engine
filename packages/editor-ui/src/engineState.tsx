import { createContext, useContext, useEffect, useState } from 'react';
import type { EditorHost, EngineConnection } from './host';
import type { EngineMessage } from './protocol';

type Stats = Extract<EngineMessage, { type: 'stats' }>;

/** A line of the console. */
export interface LogEntry {
  readonly id: number;
  readonly time: Date;
  readonly level: 'info' | 'error';
  readonly text: string;
}

// The last lines kept.
const logLength = 200;

/** What the engine tells of itself, for the bars and the panels. */
export interface EngineState {
  readonly device: string;
  readonly backend: string;
  readonly fallback?: string;
  readonly scenes: readonly string[];
  readonly scene: string;
  readonly loading: boolean;
  readonly stats?: Stats;
  readonly error: string;
  readonly log: readonly LogEntry[];
  showScene(name: string): void;
}

/** The state of the engine, from its messages. */
export function useEngine(engine: EngineConnection): EngineState {
  const [device, setDevice] = useState('');
  const [backend, setBackend] = useState('');
  const [fallback, setFallback] = useState<string>();
  const [scenes, setScenes] = useState<readonly string[]>([]);
  const [scene, setScene] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState('');
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  useEffect(() => {
    let id = 0;
    const write = (level: LogEntry['level'], text: string) =>
      setLog((lines) => [
        ...lines.slice(-(logLength - 1)),
        { id: id++, time: new Date(), level, text },
      ]);
    return engine.subscribe((message) => {
      switch (message.type) {
        case 'ready':
          setDevice(message.device);
          setBackend(message.backend);
          setFallback(message.fallback);
          setScenes(message.scenes);
          setScene(message.scene);
          write('info', `Engine ready: ${message.backend} · ${message.device}`);
          if (message.fallback) {
            write(
              'error',
              `${message.backend} as a fallback: ${message.fallback}`,
            );
          }
          break;
        case 'loading':
          setLoading(true);
          setError('');
          write('info', `Loading ${message.scene}`);
          break;
        case 'stats':
          setStats(message);
          setLoading(false);
          break;
        case 'error':
          setError(message.message);
          setLoading(false);
          write('error', message.message);
          break;
      }
    });
  }, [engine]);
  const showScene = (name: string) => {
    setScene(name);
    engine.post({ type: 'scene', name });
  };
  return {
    device,
    backend,
    fallback,
    scenes,
    scene,
    loading,
    stats,
    error,
    log,
    showScene,
  };
}

/** The host and the state of its engine, for the panels. */
export interface EditorContextValue {
  readonly host: EditorHost;
  readonly engine: EngineState;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor outside of the EditorShell');
  return value;
}
