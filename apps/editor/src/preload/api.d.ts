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
}

declare global {
  interface Window {
    readonly editor: EditorApi;
  }
}
