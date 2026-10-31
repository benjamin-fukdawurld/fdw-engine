import {
  app,
  MessageChannelMain,
  utilityProcess,
  type BrowserWindow,
  type UtilityProcess,
} from 'electron';
import { join } from 'node:path';
import type { ControlMessage } from '../shared/protocol';
import enginePath from '../engine/index?modulePath';
import dawnPath from '../engine/dawn?modulePath';

// From out/main, where the bundle runs.
const repositoryRoot = join(__dirname, '../../../..');

/**
 * Where the engine process finds its files: in the repository, or in the
 * resources of the executable (scripts/package.mjs), with the programs
 * precompiled for it.
 */
function engineFiles(): Record<string, string> {
  if (app.isPackaged) {
    const addons = join(process.resourcesPath, 'addons');
    return {
      FDW_EDITOR_ADDON: join(addons, 'editor/fdw_editor.node'),
      FDW_VULKAN_ADDON: join(addons, 'engine-vulkan/fdw_vulkan.node'),
      FDW_D3D12_ADDON: join(addons, 'engine-d3d12/fdw_d3d12.node'),
      FDW_NATIVE_ADDON: join(addons, 'engine-native/fdw_native.node'),
      FDW_MODELS: join(process.resourcesPath, 'models'),
      FDW_SHIPPED_SHADERS: join(process.resourcesPath, 'shaders'),
    };
  }
  return {
    // Its Node process on Dawn: not in the executable.
    FDW_DAWN_PROCESS: dawnPath,
    FDW_EDITOR_ADDON: join(__dirname, '../../build/fdw_editor.node'),
    // The addons of the engine, built in their packages.
    FDW_VULKAN_ADDON: join(
      repositoryRoot,
      'packages/engine-vulkan/build/fdw_vulkan.node',
    ),
    FDW_D3D12_ADDON: join(
      repositoryRoot,
      'packages/engine-d3d12/build/fdw_d3d12.node',
    ),
    FDW_NATIVE_ADDON: join(
      repositoryRoot,
      'packages/engine-native/build/fdw_native.node',
    ),
    // The models of the documentation (the forest of tps).
    FDW_MODELS: join(repositoryRoot, 'apps/docs/public/models'),
  };
}

// The XID of a window (32 bits from Electron, x11::Window, or a long), or
// its HWND.
function windowId(window: BrowserWindow): bigint {
  const handle = window.getNativeWindowHandle();
  return handle.length === 4
    ? BigInt(handle.readUInt32LE())
    : handle.readBigUInt64LE();
}

/**
 * The engine of a window, in a utility process of its own (src/engine): it
 * renders into a child window placed over the area of the page that React
 * reserves. The page and the engine talk over a MessagePort, given to both
 * at each page load: the main process stays out of the frames. Linux (X11)
 * and Windows.
 */
export class EngineProcess {
  readonly #child: UtilityProcess;
  readonly #exited: Promise<void>;

  constructor(window: BrowserWindow) {
    this.#child = utilityProcess.fork(enginePath, [], {
      serviceName: 'FDW Engine',
      stdio: 'inherit',
      // The process runs from out/main/chunks: the paths are given to it.
      env: { ...process.env, ...engineFiles() },
    });
    this.#exited = new Promise((resolve) =>
      this.#child.once('exit', () => resolve()),
    );
    this.#post({
      type: 'init',
      parent: windowId(window).toString(),
      // Vulkan by default, Dawn as a fallback (design/editor-ui.md §4).
      backend: process.env['FDW_BACKEND'],
    });
  }

  /** Gives a new port to the engine to the page of the window. */
  connect(window: BrowserWindow): void {
    const { port1, port2 } = new MessageChannelMain();
    this.#child.postMessage({ type: 'connect' } satisfies ControlMessage, [
      port1,
    ]);
    window.webContents.postMessage('engine:port', null, [port2]);
  }

  /** No frames while the window is minimized or hidden. */
  setVisible(visible: boolean): void {
    this.#post({ type: 'visible', visible });
  }

  /**
   * Stops the engine, which destroys its swapchain and window: before the
   * Electron window goes, with the child window in it. Killed if it does
   * not stop in time.
   */
  async quit(timeout = 3000): Promise<void> {
    this.#post({ type: 'quit' });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), timeout);
    });
    if ((await Promise.race([this.#exited, late])) === 'late') {
      this.#child.kill();
    }
    clearTimeout(timer);
  }

  #post(message: ControlMessage): void {
    this.#child.postMessage(message);
  }
}
