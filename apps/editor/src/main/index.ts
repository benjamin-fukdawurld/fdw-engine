import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { EngineProcess } from './engine';
import {
  appPages,
  denyPermissions,
  fromAppPage,
  handleHostServices,
  keepOnAppPages,
} from './host';

// The native viewport is a child X11 window: under Wayland, Electron runs
// on XWayland.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
// The tests give the editor a user data of its own: its layout, its storage.
const userData = process.env['FDW_USER_DATA'];
if (userData) app.setPath('userData', userData);

// electron-vite sets this variable in dev mode to point at its HMR server.
const rendererUrl = app.isPackaged
  ? undefined
  : process.env['ELECTRON_RENDERER_URL'];
const pages = appPages(rendererUrl);

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
  keepOnAppPages(window.webContents, pages);

  let engine: EngineProcess | undefined;
  // The page asks for its port once loaded, again after a reload.
  let connectAsked = false;
  const onConnect = (event: Electron.IpcMainEvent) => {
    if (event.sender !== window.webContents || !fromAppPage(pages, event)) {
      return;
    }
    connectAsked = true;
    engine?.connect(window);
  };
  ipcMain.on('engine:connect', onConnect);
  // However the window goes (its engine stopped, or never started).
  window.once('closed', () => ipcMain.off('engine:connect', onConnect));

  window.once('ready-to-show', () => {
    window.show();
    if (process.platform === 'linux' || process.platform === 'win32') {
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
    const stopping = engine;
    engine = undefined;
    void stopping.quit().then(() => window.destroy());
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  denyPermissions(pages);
  handleHostServices(pages);
  createWindow();
  // macOS: recreate a window when the dock icon is clicked and none is open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
