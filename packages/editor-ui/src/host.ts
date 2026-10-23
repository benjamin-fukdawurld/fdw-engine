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

/**
 * What an application gives the shell: the Electron editor (apps/editor) or
 * the web one. The files, the persistence, the popouts and the plugins
 * come with the steps that use them.
 */
export interface EditorHost {
  readonly engine: EngineConnection;
  /** The area where the engine shows its view, filling its parent. */
  readonly Viewport: ComponentType;
  /** Shown at the right of the status bar: the platform, the versions. */
  readonly about: string;
}
