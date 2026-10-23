import { useEffect, useRef, useState } from 'react';
import {
  MenuBar,
  ShellContext,
  StatusBar,
  ToolbarArea,
  type ShellValue,
} from './chrome';
import { EditorContext, useEditor, useEditorStore } from './editorContext';
import type { EditorHost, HostStorage } from './host';
import { layoutKey, layoutVersion, readLayout, type Layout } from './layout';
import { panels } from './panels';
import { connectEngineStore, createEngineStore } from './state/engineStore';
import { createEditorRuntime, type EditorRuntime } from './state/runtime';
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

// The runtime of the editor, made once the layout is read, with the state
// it keeps; the engine is followed from the start, not to miss its
// first messages.
function useEditorRuntime(host: EditorHost) {
  const [engine] = useState(createEngineStore);
  useEffect(() => connectEngineStore(host.engine, engine), [host, engine]);
  const saved = useSavedLayout(host.storage);
  const [runtime, setRuntime] = useState<{
    runtime: EditorRuntime;
    layout?: Layout;
  }>();
  useEffect(() => {
    if (!saved) return;
    const created = createEditorRuntime({ host, engine, saved: saved.layout });
    setRuntime({ runtime: created, layout: saved.layout });
    return () => created.dispose();
  }, [host, engine, saved]);
  return runtime;
}

/**
 * The interface of the editor, the same in every host, laid out like a
 * QMainWindow (design/editor-ui.md §3): the menu bar, the toolbars on the
 * four sides, the docks around the central area, the status bar. Its state
 * and its services (design/editor-state.md) are its runtime, made once the
 * layout kept by the host is read.
 */
export function EditorShell({
  host,
  onRuntime,
}: {
  readonly host: EditorHost;
  /** Given the runtime once made: its services, stores and machine. */
  readonly onRuntime?: (runtime: EditorRuntime) => void;
}) {
  const made = useEditorRuntime(host);
  const onRuntimeRef = useRef(onRuntime);
  onRuntimeRef.current = onRuntime;
  useEffect(() => {
    if (made) onRuntimeRef.current?.(made.runtime);
  }, [made]);
  if (!made) return <div className="h-screen bg-background" />;
  return (
    <EditorContext.Provider value={made.runtime}>
      <Shell saved={made.layout} />
    </EditorContext.Provider>
  );
}

function Shell({ saved }: { readonly saved?: Layout }) {
  const runtime = useEditor();
  const { editor, machine } = runtime;
  const chrome = useEditorStore();
  const [openPanels, setOpenPanels] = useState<readonly string[]>([]);
  // A new key remounts the workbench, with the default layout.
  const [generation, setGeneration] = useState(0);
  const workbench = useRef<WorkbenchApi>(undefined);

  // The layout taken at each change, written once the changes settle, and
  // when the shell goes (its panels may be gone by then).
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Layout>(undefined);
  const storage = runtime.host.storage;
  const write = () => {
    clearTimeout(timer.current);
    if (pending.current) void storage.write(layoutKey, pending.current);
    pending.current = undefined;
  };
  const save = () => {
    pending.current = {
      version: layoutVersion,
      areas: {},
      ...runtime.persist(),
      ...workbench.current?.toJSON(),
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(write, saveDelay);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => () => writeRef.current(), []);

  // The state of the editor changed: the chrome, the mode, the tools.
  useEffect(() => {
    const changed = () => saveRef.current();
    const subscriptions = [
      editor.subscribe(changed),
      machine.subscribe(changed),
    ];
    return () =>
      subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, [editor, machine]);

  // The focus of the window, for the machine.
  useEffect(() => {
    const send = () =>
      machine.send({ type: 'FOCUS.WINDOW', focused: document.hasFocus() });
    send();
    window.addEventListener('focus', send);
    window.addEventListener('blur', send);
    return () => {
      window.removeEventListener('focus', send);
      window.removeEventListener('blur', send);
    };
  }, [machine]);

  const shell: ShellValue = {
    openPanels,
    togglePanel: (id, open) => {
      if (!open) {
        workbench.current?.closePanel(id);
        return;
      }
      // Its dock shown first.
      const area = panels[id]?.area;
      if (area && area !== 'center' && !chrome.docks[area]) {
        editor.trigger.setDock({ dock: area, shown: true });
      }
      workbench.current?.openPanel(id);
    },
    resetLayout: () => {
      workbench.current = undefined;
      editor.trigger.resetChrome();
      setGeneration((value) => value + 1);
      save();
    },
  };

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-screen flex-col bg-background text-[13px] text-foreground">
        <MenuBar />
        <ToolbarArea side="top" />
        <div className="flex min-h-0 flex-1">
          <ToolbarArea side="left" />
          <main className="min-h-0 min-w-0 flex-1">
            <Workbench
              key={generation}
              // The saved layout, until reset.
              saved={generation === 0 ? saved : undefined}
              docksShown={chrome.docks}
              onReady={(api) => {
                workbench.current = api;
                setOpenPanels(api.openPanels());
              }}
              onChange={save}
              onPanelsChange={() =>
                setOpenPanels(workbench.current?.openPanels() ?? [])
              }
              onFocus={(area, view) =>
                machine.send({ type: 'FOCUS.VIEW', area, view })
              }
              onActivePanelChange={(area, view) => {
                // In the area that has the focus only.
                if (machine.getSnapshot().context.focus.area === area) {
                  machine.send({ type: 'FOCUS.VIEW', area, view });
                }
              }}
            />
          </main>
          <ToolbarArea side="right" />
        </div>
        <ToolbarArea side="bottom" />
        {chrome.statusBar && <StatusBar />}
      </div>
    </ShellContext.Provider>
  );
}
