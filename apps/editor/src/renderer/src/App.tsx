import { useState, type CSSProperties } from 'react';
import { Viewport } from './Viewport';

const panel: CSSProperties = {
  background: '#26262b',
  padding: 12,
  overflow: 'auto',
};

export function App() {
  const { platform, versions } = window.editor;
  const [outlinerOpen, setOutlinerOpen] = useState(true);
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
      </header>
      <aside style={{ ...panel, padding: outlinerOpen ? 12 : 0 }}>
        {outlinerOpen && 'Outliner'}
      </aside>
      <Viewport />
      <aside style={panel}>Inspector</aside>
      <footer
        style={{
          gridColumn: '1 / -1',
          padding: '4px 12px',
          background: '#2d2d33',
        }}
      >
        Electron {versions.electron} · Chrome {versions.chrome} · Node{' '}
        {versions.node} · {platform}
      </footer>
    </div>
  );
}
