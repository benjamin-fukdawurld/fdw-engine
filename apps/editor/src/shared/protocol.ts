// The messages of the Electron host; those between the page and the engine
// are the contract of @fdw/editor-ui (its protocol.ts).
import type { PageMessage } from '@fdw/editor-ui/protocol';

/** From the main process to the engine process (process.parentPort). */
export type ControlMessage =
  // The handle of the Electron window (an XID, a HWND), in decimal, and the
  // backend asked for (FDW_BACKEND).
  | {
      readonly type: 'init';
      readonly parent: string;
      readonly backend?: string;
    }
  // With a new port to the page (one per page load).
  | { readonly type: 'connect' }
  // The window was minimized or hidden, or comes back.
  | { readonly type: 'visible'; readonly visible: boolean }
  | { readonly type: 'quit' };

/**
 * From the engine process to its Dawn process (process.send), which sends
 * back the EngineMessages to the page.
 */
export type DawnControlMessage =
  // The handle of the Electron window, and why Vulkan was not used.
  | {
      readonly type: 'init';
      readonly parent: string;
      readonly fallback?: string;
    }
  // A new page: the engine tells it again that it is ready.
  | { readonly type: 'connect' }
  | { readonly type: 'page'; readonly message: Wire<PageMessage> }
  | { readonly type: 'visible'; readonly visible: boolean }
  | { readonly type: 'quit' };

/**
 * A message over the IPC of Node, as JSON (the V8 serializers of Electron
 * and Node differ): the bytes of a level or of an extension (`data`) in
 * base64.
 */
export type Wire<M> = M extends { readonly data: Uint8Array }
  ? Omit<M, 'data'> & { readonly data: string }
  : M extends { readonly data?: Uint8Array }
    ? Omit<M, 'data'> & { readonly data?: string }
    : M;
