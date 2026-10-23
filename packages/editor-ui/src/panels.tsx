import type { IDockviewPanelProps } from 'dockview-react';
import type { FunctionComponent } from 'react';
import { useEditor } from './engineState';
import type { AreaId } from './layout';
import { cn } from './lib/utils';

/** A panel of the editor: where it opens by default, what it shows. */
export interface PanelSpec {
  readonly title: string;
  readonly area: AreaId;
  readonly component: FunctionComponent<IDockviewPanelProps>;
}

function ViewportPanel() {
  const { Viewport } = useEditor().host;
  return (
    <div className="h-full w-full bg-black">
      <Viewport />
    </div>
  );
}

function Placeholder({ text }: { readonly text: string }) {
  return (
    <div className="h-full overflow-auto p-3 text-muted-foreground">{text}</div>
  );
}

function ConsolePanel() {
  const { log } = useEditor().engine;
  return (
    <div className="h-full overflow-auto px-3 py-1 font-mono text-xs">
      {log.map((entry) => (
        <div
          key={entry.id}
          className={cn(entry.level === 'error' && 'text-destructive')}
        >
          <span className="text-muted-foreground">
            {entry.time.toLocaleTimeString()}
          </span>{' '}
          {entry.text}
        </div>
      ))}
    </div>
  );
}

function WelcomePanel() {
  const { host } = useEditor();
  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-2 text-base font-semibold">FDW Editor</h1>
      <p className="text-muted-foreground">
        Drag the tabs to split the central area or a dock; the View menu shows
        and hides the docks, the panels and the toolbars.
      </p>
      <p className="mt-4 text-xs text-muted-foreground">{host.about}</p>
    </div>
  );
}

/**
 * The panels of the editor, by id. They become built-in plugins with the
 * registries (step 12 of P18).
 */
export const panels: Readonly<Record<string, PanelSpec>> = {
  viewport: { title: 'Viewport', area: 'center', component: ViewportPanel },
  welcome: { title: 'Welcome', area: 'center', component: WelcomePanel },
  outliner: {
    title: 'Outliner',
    area: 'left',
    component: () => <Placeholder text="The scene, with P15 and P16." />,
  },
  inspector: {
    title: 'Inspector',
    area: 'right',
    component: () => <Placeholder text="Nothing selected." />,
  },
  console: { title: 'Console', area: 'bottom', component: ConsolePanel },
};

/** The panels open in each area of a new layout. */
export const defaultPanels: Readonly<Record<AreaId, readonly string[]>> = {
  center: ['viewport'],
  left: ['outliner'],
  right: ['inspector'],
  bottom: ['console'],
};
