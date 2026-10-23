import type { EditorHost, HostStorage } from '@fdw/editor-ui';
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
 * Access API.
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
  };
}
