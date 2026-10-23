import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useEditor, useItems } from './editorContext';

/** A text in a panel, for what has nothing to show yet. */
export function PanelMessage({ text }: { readonly text: string }) {
  return (
    <div className="h-full overflow-auto p-3 text-muted-foreground">{text}</div>
  );
}

/**
 * A panel of dockview: the component of its view (the panel has the id of
 * the view), its plugin activated if it is not yet (`onView:id`). A view no
 * plugin declares, kept in a layout, is a panel of a missing plugin.
 */
export function ViewHost({ api }: IDockviewPanelProps) {
  const { id } = api;
  const runtime = useEditor();
  const { plugins } = runtime;
  const spec = useItems(runtime.views).find((view) => view.id === id);
  const component = useItems(runtime.viewComponents).find(
    (item) => item.id === id,
  );
  const status = useSyncExternalStore(plugins.subscribe, () =>
    spec ? plugins.info(spec.plugin)?.status : undefined,
  );
  useEffect(() => {
    if (spec && !component && status === 'inactive') {
      void plugins.activateByEvent(`onView:${id}`);
    }
  }, [plugins, id, spec, component, status]);
  if (!spec) {
    return (
      <PanelMessage
        text={`No plugin gives the view ${id}: its plugin is missing.`}
      />
    );
  }
  if (component) return <component.component />;
  const { plugin } = spec;
  switch (status) {
    case 'failed':
      return <PanelMessage text={`The plugin ${plugin} failed.`} />;
    case 'disabled':
      return <PanelMessage text={`The plugin ${plugin} is disabled.`} />;
    case 'active':
      return <PanelMessage text={`The plugin ${plugin} shows nothing here.`} />;
    default:
      return <PanelMessage text="Loading…" />;
  }
}
