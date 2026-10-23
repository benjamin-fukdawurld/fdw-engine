// The messages of the Electron host; those between the page and the engine
// are the contract of @fdw/editor-ui (its protocol.ts).

/** From the main process to the engine process (process.parentPort). */
export type ControlMessage =
  // The XID of the Electron window, in decimal.
  | { readonly type: 'init'; readonly parent: string }
  // With a new port to the page (one per page load).
  | { readonly type: 'connect' }
  // The window was minimized or hidden, or comes back.
  | { readonly type: 'visible'; readonly visible: boolean }
  | { readonly type: 'quit' };
