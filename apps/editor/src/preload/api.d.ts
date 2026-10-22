/** API exposed by the preload script on `window.editor`. */
export interface EditorApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  /**
   * Places the native viewport over an area of the page, in device pixels
   * from the top left corner of the page. An empty area hides it.
   */
  setViewportBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): void;
}

declare global {
  interface Window {
    readonly editor: EditorApi;
  }
}
