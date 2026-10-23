import type { FileFilter, HostFile } from '@fdw/editor-ui';

/** API exposed by the preload script on `window.editor`. */
export interface EditorApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  /**
   * Asks for a port to the engine process: it comes as a message of the
   * window, `'engine:port'`, with the port in its `ports`. Again after
   * each page load.
   */
  connectEngine(): void;
  /** A JSON file of the user data, undefined if none. */
  readStorage(key: string): Promise<unknown>;
  writeStorage(key: string, value: unknown): Promise<void>;
  /** The dialogs of Electron, the file read or written by the main process. */
  openFile(filters?: readonly FileFilter[]): Promise<HostFile | undefined>;
  saveFile(
    name: string,
    data: Uint8Array,
    filters?: readonly FileFilter[],
  ): Promise<boolean>;
}

declare global {
  interface Window {
    readonly editor: EditorApi;
  }
}
