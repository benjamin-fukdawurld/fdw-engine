import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { EngineProcess } from './engine';

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

  let engine: EngineProcess | undefined;
  // The page asks for its port once loaded, again after a reload.
  let connectAsked = false;
  const onConnect = (event: Electron.IpcMainEvent) => {
    if (event.sender !== window.webContents) return;
    connectAsked = true;
    engine?.connect(window);
  };
  ipcMain.on('engine:connect', onConnect);

  window.once('ready-to-show', () => {
    window.show();
    if (process.platform === 'linux') {
      engine = new EngineProcess(window);
      if (connectAsked) engine.connect(window);
    }
  });
  window.on('minimize', () => engine?.setVisible(false));
  window.on('hide', () => engine?.setVisible(false));
  window.on('restore', () => engine?.setVisible(true));
  window.on('show', () => engine?.setVisible(true));
  // The engine stops before the native window goes, with the child window
  // in it.
  window.on('close', (event) => {
    if (!engine) return;
    event.preventDefault();
    ipcMain.off('engine:connect', onConnect);
    const stopping = engine;
    engine = undefined;
    void stopping.quit().then(() => window.destroy());
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
