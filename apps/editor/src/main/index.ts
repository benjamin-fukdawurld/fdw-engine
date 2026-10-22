import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { NativeViewport, type ViewportBounds } from './viewport';

// The native viewport is a child X11 window: under Wayland, Electron runs
// on XWayland.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'FDW Editor',
    backgroundColor: '#1e1e22',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // No menu bar: the page starts at the top of the native window, where the
  // viewport bounds are measured from.
  window.removeMenu();

  let viewport: NativeViewport | undefined;
  let bounds: ViewportBounds | undefined;
  const onBounds = (event: Electron.IpcMainEvent, next: ViewportBounds) => {
    if (event.sender !== window.webContents) return;
    bounds = next;
    viewport?.setBounds(next);
  };
  ipcMain.on('viewport:bounds', onBounds);

  window.once('ready-to-show', () => {
    window.show();
    if (process.platform === 'linux') {
      viewport = new NativeViewport(window);
      if (bounds) viewport.setBounds(bounds);
    }
  });
  // Before the native window goes, with the child window in it.
  window.on('close', () => {
    ipcMain.off('viewport:bounds', onBounds);
    viewport?.destroy();
    viewport = undefined;
  });

  // electron-vite sets this variable in dev mode to point at its HMR server.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  createWindow();
  // macOS: recreate a window when the dock icon is clicked and none is open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
