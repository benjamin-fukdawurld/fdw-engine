import { useEffect, useRef, useState } from 'react';
import {
  MenuBar,
  ShellContext,
  StatusBar,
  ToolbarArea,
  type ShellValue,
} from './chrome';
import { EditorContext, useEngine } from './engineState';
import type { EditorHost, HostStorage } from './host';
import {
  defaultChrome,
  layoutKey,
  layoutVersion,
  readLayout,
  type Chrome,
  type Layout,
} from './layout';
import { panels } from './panels';
import { Workbench, type WorkbenchApi } from './Workbench';

// The writes of the layout wait for the changes to settle (a sash dragged).
const saveDelay = 300;

// The layout read from the storage of the host; null until read.
function useSavedLayout(storage: HostStorage) {
  const [saved, setSaved] = useState<{ layout?: Layout } | null>(null);
  useEffect(() => {
    let current = true;
    void storage
      .read(layoutKey)
      .catch(() => undefined)
      .then((value) => {
        if (current) setSaved({ layout: readLayout(value) });
      });
    return () => {
      current = false;
    };
  }, [storage]);
  return saved;
}

/**
 * The interface of the editor, the same in every host, laid out like a
 * QMainWindow (design/editor-ui.md §3): the menu bar, the toolbars on the
 * four sides, the docks around the central area, the status bar. The
 * layout is kept by the host.
 */
export function EditorShell({ host }: { readonly host: EditorHost }) {
  const engine = useEngine(host.engine);
  const saved = useSavedLayout(host.storage);
  const [chrome, setChromeState] = useState<Chrome>(defaultChrome);
  const [openPanels, setOpenPanels] = useState<readonly string[]>([]);
  // A new key remounts the workbench, with the default layout.
  const [generation, setGeneration] = useState(0);
  const workbench = useRef<WorkbenchApi>(undefined);
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useEffect(() => {
    if (saved?.layout) setChromeState(saved.layout);
  }, [saved]);

  // The layout taken at each change, written once the changes settle, and
  // when the shell goes (its panels may be gone by then).
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Layout>(undefined);
  const storage = host.storage;
  const write = () => {
    clearTimeout(timer.current);
    if (pending.current) void storage.write(layoutKey, pending.current);
    pending.current = undefined;
  };
  const save = () => {
    const { docks, toolbars, statusBar } = chromeRef.current;
    pending.current = {
      version: layoutVersion,
      docks,
      toolbars,
      statusBar,
      areas: {},
      ...workbench.current?.toJSON(),
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(write, saveDelay);
  };
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => () => writeRef.current(), []);

  const shell: ShellValue = {
    chrome,
    setChrome: (change) => {
      chromeRef.current = change(chromeRef.current);
      setChromeState(chromeRef.current);
      save();
    },
    openPanels,
    togglePanel: (id, open) => {
      if (!open) {
        workbench.current?.closePanel(id);
        return;
      }
      // Its dock shown first.
      const area = panels[id]?.area;
      if (area && area !== 'center' && !chrome.docks[area]) {
        shell.setChrome((current) => ({
          ...current,
          docks: { ...current.docks, [area]: true },
        }));
      }
      workbench.current?.openPanel(id);
    },
    resetLayout: () => {
      workbench.current = undefined;
      chromeRef.current = defaultChrome;
      setChromeState(defaultChrome);
      setGeneration((value) => value + 1);
      save();
    },
  };

  return (
    <EditorContext.Provider value={{ host, engine }}>
      <ShellContext.Provider value={shell}>
        <div className="flex h-screen flex-col bg-background text-[13px] text-foreground">
          <MenuBar />
          <ToolbarArea side="top" />
          <div className="flex min-h-0 flex-1">
            <ToolbarArea side="left" />
            <main className="min-h-0 min-w-0 flex-1">
              {saved && (
                <Workbench
                  key={generation}
                  // The saved layout, until reset.
                  saved={generation === 0 ? saved.layout : undefined}
                  docksShown={chrome.docks}
                  onReady={(api) => {
                    workbench.current = api;
                    setOpenPanels(api.openPanels());
                  }}
                  onChange={save}
                  onPanelsChange={() =>
                    setOpenPanels(workbench.current?.openPanels() ?? [])
                  }
                />
              )}
            </main>
            <ToolbarArea side="right" />
          </div>
          <ToolbarArea side="bottom" />
          {chrome.statusBar && <StatusBar />}
        </div>
      </ShellContext.Provider>
    </EditorContext.Provider>
  );
}
