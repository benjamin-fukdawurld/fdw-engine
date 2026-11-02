import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  session,
  type WebContents,
} from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The services of the host for the page (see src/preload/api.d.ts): its
// storage, files of the user data; the dialogs for its files.

type Filters = OpenDialogOptions['filters'];

/** The pages of the editor, by their exact URLs: its window, its popouts. */
export interface AppPages {
  readonly index: string;
  readonly popout: string;
}

/**
 * The pages shipped (`file:` URLs next to the main process), or those of
 * the dev server of electron-vite. Every `file:` URL has the origin "null":
 * the pages are told by their whole URL, not by their origin.
 */
export function appPages(rendererUrl?: string): AppPages {
  const page = (url: string) => bare(url) ?? url;
  if (rendererUrl) {
    return {
      index: page(rendererUrl),
      popout: page(new URL('popout.html', rendererUrl).href),
    };
  }
  const shipped = (name: string) =>
    page(pathToFileURL(join(__dirname, '../renderer', name)).href);
  return { index: shipped('index.html'), popout: shipped('popout.html') };
}

// A URL without its query and its fragment (the paths of Windows in any
// case).
function bare(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.protocol === 'file:' && process.platform === 'win32'
      ? parsed.href.toLowerCase()
      : parsed.href;
  } catch {
    return undefined;
  }
}

/** Whether a URL is one of the pages of the editor. */
export function isAppPage(pages: AppPages, url: string): boolean {
  const page = bare(url);
  return page !== undefined && (page === pages.index || page === pages.popout);
}

/**
 * Whether an IPC message comes from a page of the editor: the preload is in
 * every page of its windows, and a frame elsewhere must not reach the
 * storage, the files or the engine.
 */
export function fromAppPage(
  pages: AppPages,
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  const url = event.senderFrame?.url;
  return url !== undefined && isAppPage(pages, url);
}

/**
 * Refuses every permission (the camera, the notifications, the location…)
 * but the writing of the clipboard by the pages of the editor (a copy of
 * a fragment of a graph).
 */
export function denyPermissions(pages: AppPages): void {
  const allowed = (permission: string, url: string | undefined) =>
    permission === 'clipboard-sanitized-write' &&
    url !== undefined &&
    isAppPage(pages, url);
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) =>
      callback(allowed(permission, details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, _origin, details) =>
      allowed(permission, details.requestingUrl),
  );
}

// The keys of the storage name files: no path in them.
const storageKey = /^[\w.-]+$/;

function storagePath(key: unknown): string {
  if (typeof key !== 'string' || !storageKey.test(key) || key.startsWith('.')) {
    throw new Error(`Invalid storage key: ${String(key)}`);
  }
  return join(app.getPath('userData'), 'storage', `${key}.json`);
}

// The window of the page asking: the parent of its dialogs.
function windowOf(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('No window for this page');
  return window;
}

// Refuses a message that does not come from a page of the editor.
function checkSender(
  pages: AppPages,
  event: IpcMainEvent | IpcMainInvokeEvent,
): void {
  if (!fromAppPage(pages, event)) {
    throw new Error(`Refused: ${event.senderFrame?.url ?? 'no frame'}`);
  }
}

export function handleHostServices(pages: AppPages): void {
  const handle = <A extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: A) => unknown,
  ) =>
    ipcMain.handle(channel, (event, ...args: A) => {
      checkSender(pages, event);
      return handler(event, ...args);
    });

  handle('storage:read', async (_event, key: unknown) => {
    try {
      return JSON.parse(await readFile(storagePath(key), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  });

  // Written aside, then renamed: never half a file.
  handle('storage:write', async (_event, key: unknown, value: unknown) => {
    const path = storagePath(key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${path}.tmp`, path);
  });

  handle('files:open', async (event, filters: Filters) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(
      windowOf(event),
      { properties: ['openFile'], filters },
    );
    const path = filePaths[0];
    if (canceled || !path) return undefined;
    return { name: basename(path), data: new Uint8Array(await readFile(path)) };
  });

  handle(
    'files:save',
    async (event, name: string, data: Uint8Array, filters: Filters) => {
      const { canceled, filePath } = await dialog.showSaveDialog(
        windowOf(event),
        { defaultPath: name, filters },
      );
      if (canceled || !filePath) return false;
      await writeFile(filePath, data);
      return true;
    },
  );
}

/**
 * Keeps the contents on the pages of the editor: no navigation elsewhere
 * (a link, a drop of a file, a script), and no window but its popouts,
 * the exact page popout.html shipped, kept so too.
 */
export function keepOnAppPages(contents: WebContents, pages: AppPages): void {
  contents.on('will-navigate', (event) => {
    if (!isAppPage(pages, event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (bare(url) !== pages.popout) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        backgroundColor: '#1e1e22',
        autoHideMenuBar: true,
      },
    };
  });
  contents.on('did-create-window', (popout) =>
    keepOnAppPages(popout.webContents, pages),
  );
}
