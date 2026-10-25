import type { EngineConnection } from './host';

/**
 * The channel of a plugin to its part in the engine (an EngineExtension of
 * the same id, given to the engine by the host): the `extension` messages
 * of the protocol, under its id.
 */
export interface ExtensionChannel<In = unknown, Out = unknown> {
  /** Sends a message to the engine; `data`: bytes. */
  post(message: Out, data?: Uint8Array<ArrayBuffer>): void;
  /** Listens to its part in the engine; returns the unsubscription. */
  subscribe(
    listener: (message: In, data?: Uint8Array<ArrayBuffer>) => void,
  ): () => void;
}

/**
 * The channel of a plugin to its part in the engine, over the connection
 * of the editor (`IEngineConnection`).
 *
 * @example
 * ```ts
 * const graphs = extensionChannel<GraphEvent, GraphRequest>(
 *   context.services.get(IEngineConnection),
 *   'fdw.graphs',
 * );
 * graphs.subscribe((event) => console.log(event.op));
 * graphs.post({ op: 'targets' });
 * ```
 */
export function extensionChannel<In = unknown, Out = unknown>(
  connection: EngineConnection,
  id: string,
): ExtensionChannel<In, Out> {
  return {
    post: (message, data) =>
      connection.post({
        type: 'extension',
        extension: id,
        message,
        ...(data && { data }),
      }),
    subscribe: (listener) =>
      connection.subscribe((message) => {
        if (message.type === 'extension' && message.extension === id) {
          listener(message.message as In, message.data);
        }
      }),
  };
}
