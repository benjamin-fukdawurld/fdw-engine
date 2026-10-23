import { PanelLeftIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from './components/ui/native-select';
import type { EditorHost, EngineConnection, HostStorage } from './host';
import { cn } from './lib/utils';
import type { EngineMessage } from './protocol';

type Stats = Extract<EngineMessage, { type: 'stats' }>;

// What the engine tells of itself.
function useEngine(engine: EngineConnection) {
  const [device, setDevice] = useState('');
  const [backend, setBackend] = useState('');
  const [fallback, setFallback] = useState<string>();
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
            setBackend(message.backend);
            setFallback(message.fallback);
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
    [engine],
  );
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
    showScene,
    loading,
    stats,
    error,
  };
}

/** The layout kept by the host between sessions. */
export interface Layout {
  readonly outlinerOpen: boolean;
}

const layoutKey = 'layout';

// The layout, read from the storage of the host, written there when changed.
function useLayout(storage: HostStorage) {
  const [layout, setLayout] = useState<Layout>({ outlinerOpen: true });
  useEffect(() => {
    let current = true;
    void storage.read(layoutKey).then((saved) => {
      const open = (saved as Partial<Layout> | undefined)?.outlinerOpen;
      if (current && typeof open === 'boolean') {
        setLayout({ outlinerOpen: open });
      }
    });
    return () => {
      current = false;
    };
  }, [storage]);
  const changeLayout = (next: Layout) => {
    setLayout(next);
    void storage.write(layoutKey, next);
  };
  return [layout, changeLayout] as const;
}

/** The interface of the editor, the same in every host. */
export function EditorShell({ host }: { readonly host: EditorHost }) {
  const { Viewport } = host;
  const [layout, setLayout] = useLayout(host.storage);
  const { outlinerOpen } = layout;
  const {
    device,
    backend,
    fallback,
    scenes,
    scene,
    showScene,
    loading,
    stats,
    error,
  } = useEngine(host.engine);
  return (
    <div
      className={cn(
        'grid h-screen grid-rows-[36px_1fr_24px] bg-background text-[13px] text-foreground',
        outlinerOpen
          ? 'grid-cols-[240px_1fr_280px]'
          : 'grid-cols-[0px_1fr_280px]',
      )}
    >
      <header className="col-span-full flex items-center gap-3 border-b bg-card px-3">
        <strong className="font-semibold">FDW Editor</strong>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={outlinerOpen}
          onClick={() => setLayout({ ...layout, outlinerOpen: !outlinerOpen })}
        >
          <PanelLeftIcon />
          {outlinerOpen ? 'Hide' : 'Show'} outliner
        </Button>
        <label className="flex items-center gap-2">
          Scene
          <NativeSelect
            size="xs"
            value={scene}
            disabled={scenes.length === 0}
            onChange={(event) => showScene(event.target.value)}
          >
            {scenes.map((name) => (
              <NativeSelectOption key={name}>{name}</NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {loading && <span className="text-muted-foreground">Loading…</span>}
      </header>
      <aside
        className={cn('overflow-auto border-r bg-card', outlinerOpen && 'p-3')}
      >
        {outlinerOpen && 'Outliner'}
      </aside>
      <Viewport />
      <aside className="overflow-auto border-l bg-card p-3">Inspector</aside>
      <footer className="col-span-full flex items-center gap-3 overflow-hidden whitespace-nowrap border-t bg-card px-3 text-xs">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span>
            {device ? `${backend} · ${device}` : 'Starting the engine…'}
            {stats &&
              ` · ${stats.fps} fps · ${stats.width} × ${stats.height}${
                stats.info ? ` · ${stats.info}` : ''
              }`}
          </span>
        )}
        {fallback && (
          <span className="text-amber-500" title={fallback}>
            Fallback: {fallback}
          </span>
        )}
        <span className="ml-auto text-muted-foreground">{host.about}</span>
      </footer>
    </div>
  );
}
