import type { EditorHost, HostStorage } from '@fdw/editor-ui';
import { animationGraphPlugin } from '@fdw/editor-plugin-animation-graph';
import { behaviorGraphPlugin } from '@fdw/editor-plugin-behavior-graph';
import { isolatePlugin } from '@fdw/editor-plugin-isolate';
import { materialGraphPlugin } from '@fdw/editor-plugin-material-graph';
import { samplePlugin } from '@fdw/editor-plugin-sample';
import { CanvasViewport } from './CanvasViewport';
import type { WebEngine } from './engine';
import { webFiles } from './files';
import { indexedDbStorage } from './storage';

// The browser and its version, from the user agent.
function browser(): string {
  const match = /(Firefox|Edg|Chrome)\/(\d+)/.exec(navigator.userAgent) ?? [];
  const name = match[1] === 'Edg' ? 'Edge' : match[1];
  return name ? `${name} ${match[2]}` : 'Browser';
}

/**
 * The host of the web editor: the engine in the page, its canvas in the
 * viewport; the storage in IndexedDB, the files through the File System
 * Access API; the sample plugin, that of the tutorial of the
 * documentation (isolate) and the editors of graphs, their code in chunks
 * loaded at their first event.
 */
export function createWebHost(
  engine: WebEngine,
  storage: HostStorage = indexedDbStorage(),
): EditorHost {
  return {
    engine: engine.connection,
    Viewport: () => <CanvasViewport engine={engine} />,
    files: webFiles,
    storage,
    popoutUrl: new URL('popout.html', document.baseURI).href,
    about: `Web · ${browser()} · ${navigator.platform}`,
    plugins: [
      samplePlugin,
      isolatePlugin,
      materialGraphPlugin,
      animationGraphPlugin,
      behaviorGraphPlugin,
    ],
  };
}
