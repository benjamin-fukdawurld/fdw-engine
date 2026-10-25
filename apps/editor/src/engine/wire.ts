// The messages relayed to the Dawn process (shared/protocol.ts, Wire).
import type { EngineMessage, PageMessage } from '@fdw/editor-ui/protocol';
import type { Wire } from '../shared/protocol';

export function toWire<M extends PageMessage | EngineMessage>(
  message: M,
): Wire<M> {
  return (
    'data' in message && message.data instanceof Uint8Array
      ? { ...message, data: Buffer.from(message.data).toString('base64') }
      : message
  ) as Wire<M>;
}

export function fromWire<M extends PageMessage | EngineMessage>(
  message: Wire<M>,
): M {
  if (!('data' in message) || typeof message.data !== 'string') {
    return message as M;
  }
  const bytes = Buffer.from(message.data, 'base64');
  // A buffer of its own: not a view on the pool of Node.
  return { ...message, data: new Uint8Array(bytes) } as M;
}
