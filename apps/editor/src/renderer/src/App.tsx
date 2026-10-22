import { useEffect, useState, type CSSProperties } from 'react';
import type { EngineMessage } from '../../shared/protocol';
import { engine } from './engine';
import { Viewport } from './Viewport';

const panel: CSSProperties = {
  background: '#26262b',
  padding: 12,
  overflow: 'auto',
};

type Stats = Extract<EngineMessage, { type: 'stats' }>;

// What the engine tells of itself.
function useEngine() {
  const [device, setDevice] = useState('');
  const [scenes, setScenes] = useState<readonly string[]>([]);
  const [scene, setScene] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState('');
  useEffect(
    () =>
      engine.subscribe((message) => {
        switch (message.type) {
          case 'ready':
            setDevice(message.device);
            setScenes(message.scenes);
            setScene(message.scene);
            break;
          case 'loading':
            setLoading(true);
            setError('');
            break;
          case 'stats':
            setStats(message);
            setLoading(false);
            break;
          case 'error':
            setError(message.message);
            setLoading(false);
            break;
        }
      }),
    [],
  );
  const showScene = (name: string) => {
    setScene(name);
    engine.post({ type: 'scene', name });
  };
  return { device, scenes, scene, showScene, loading, stats, error };
}

export function App() {
  const { platform, versions } = window.editor;
  const [outlinerOpen, setOutlinerOpen] = useState(true);
  const { device, scenes, scene, showScene, loading, stats, error } =
    useEngine();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: '40px 1fr 24px',
        gridTemplateColumns: `${outlinerOpen ? 240 : 0}px 1fr 280px`,
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 13,
        color: '#ddd',
        background: '#1e1e22',
      }}
    >
      <header
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 12px',
          background: '#2d2d33',
        }}
      >
        <strong>FDW Editor</strong>
        <button onClick={() => setOutlinerOpen((open) => !open)}>
          {outlinerOpen ? 'Hide' : 'Show'} outliner
        </button>
        <label>
          Scene{' '}
          <select
            value={scene}
            disabled={scenes.length === 0}
            onChange={(event) => showScene(event.target.value)}
          >
            {scenes.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {loading && <span>Loading…</span>}
      </header>
      <aside style={{ ...panel, padding: outlinerOpen ? 12 : 0 }}>
        {outlinerOpen && 'Outliner'}
      </aside>
      <Viewport />
      <aside style={panel}>Inspector</aside>
      <footer
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          gap: 12,
          padding: '4px 12px',
          background: '#2d2d33',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {error ? (
          <span style={{ color: '#f77' }}>{error}</span>
        ) : (
          <span>
            {device || 'Starting the engine…'}
            {stats &&
              ` · ${stats.fps} fps · ${stats.width} × ${stats.height}${
                stats.info ? ` · ${stats.info}` : ''
              }`}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          Electron {versions.electron} · Chrome {versions.chrome} · Node{' '}
          {versions.node} · {platform}
        </span>
      </footer>
    </div>
  );
}
