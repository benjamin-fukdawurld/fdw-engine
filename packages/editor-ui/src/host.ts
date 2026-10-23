import type { ComponentType } from 'react';
import type { EngineMessage, PageMessage } from './protocol';

/**
 * The connection of the shell to the engine: the shell never holds an
 * object of the engine, which may run in another process.
 */
export interface EngineConnection {
  post(message: PageMessage): void;
  /** Listens to the messages of the engine; returns the unsubscription. */
  subscribe(listener: (message: EngineMessage) => void): () => void;
}

/** A kind of file the dialogs show, by its extensions (without the dot). */
export interface FileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

/** A file of the user, read whole. */
export interface HostFile {
  readonly name: string;
  readonly data: Uint8Array<ArrayBuffer>;
}

/**
 * The files of the user: the dialogs of Electron on the desktop, the File
 * System Access API (or an import and a download) on the web.
 */
export interface HostFiles {
  /** Asks for a file and reads it; undefined if cancelled. */
  open(filters?: readonly FileFilter[]): Promise<HostFile | undefined>;
  /** Asks where to write the data, named `name` by default; false if cancelled. */
  save(
    name: string,
    data: Uint8Array<ArrayBuffer>,
    filters?: readonly FileFilter[],
  ): Promise<boolean>;
}

/**
 * The documents of the editor kept between sessions (the layout), as JSON:
 * files in the user data on the desktop, IndexedDB on the web. A key is
 * made of letters, digits, dots, dashes and underscores.
 */
export interface HostStorage {
  /** The value written under the key; undefined if none. */
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}

/**
 * What an application gives the shell: the Electron editor (apps/editor) or
 * the web one. The plugins come with their manifest (step 12 of P18).
 */
export interface EditorHost {
  readonly engine: EngineConnection;
  /** The area where the engine shows its view, filling its parent. */
  readonly Viewport: ComponentType;
  readonly files: HostFiles;
  readonly storage: HostStorage;
  /**
   * The empty page that the popouts of the panels open (the `popoutUrl`
   * of dockview): the host lets the page open it in a window.
   */
  readonly popoutUrl: string;
  /** Shown at the right of the status bar: the platform, the versions. */
  readonly about: string;
}
