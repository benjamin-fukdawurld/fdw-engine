import WebGPUCanvas from './WebGPUCanvas';

export function App() {
  return (
    <div
      style={{
        display: 'flex',
        flexFlow: 'column nowrap',
        height: 'inherit',
      }}
    >
      <div style={{ height: '2rem' }}>menu bar</div>
      <div
        style={{
          display: 'flex',
          flexFlow: 'row nowrap',
          flexGrow: 1,
          border: '1px solid red',
          maxHeight: 'calc(100svh - 4rem)',
        }}
      >
        <div
          style={{
            width: '4rem',
          }}
        >
          activity
        </div>
        <WebGPUCanvas />
      </div>
      <div style={{ height: '2rem' }}>status bar</div>
    </div>
  );
}

export default App;
