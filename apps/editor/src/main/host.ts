import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// The services of the host for the page (see src/preload/api.d.ts): its
// storage, files of the user data; the dialogs for its files.

type Filters = OpenDialogOptions['filters'];

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

export function handleHostServices(): void {
  ipcMain.handle('storage:read', async (_event, key: unknown) => {
    try {
      return JSON.parse(await readFile(storagePath(key), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  });

  // Written aside, then renamed: never half a file.
  ipcMain.handle('storage:write', async (_event, key: unknown, value) => {
    const path = storagePath(key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${path}.tmp`, path);
  });

  ipcMain.handle('files:open', async (event, filters: Filters) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(
      windowOf(event),
      { properties: ['openFile'], filters },
    );
    const path = filePaths[0];
    if (canceled || !path) return undefined;
    return { name: basename(path), data: new Uint8Array(await readFile(path)) };
  });

  ipcMain.handle(
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
 * Lets the page open its popouts, the page popout.html of the renderer;
 * any other window is refused.
 */
export function allowPopouts(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    const page = new URL(window.webContents.getURL());
    if (
      target.origin !== page.origin ||
      !target.pathname.endsWith('/popout.html')
    ) {
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        backgroundColor: '#1e1e22',
        autoHideMenuBar: true,
      },
    };
  });
}
