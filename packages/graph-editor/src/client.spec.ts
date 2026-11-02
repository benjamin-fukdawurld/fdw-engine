import type { EngineMessage, PageMessage } from '@fdw/editor-ui';
import { type GraphRequest, GraphWorkspace } from '@fdw/engine-graph-editing';
import { describe, expect, it } from 'vitest';
import { GraphClient, graphsExtensionId } from './client';

// A client talking to a workspace, as to the extension of an engine.
function connect() {
  const listeners = new Set<(message: EngineMessage) => void>();
  const workspace = new GraphWorkspace({
    post: (message, data) => {
      for (const listener of [...listeners]) {
        listener({
          type: 'extension',
          extension: graphsExtensionId,
          message,
          ...(data && { data }),
        });
      }
    },
  });
  const connection = {
    post: (message: PageMessage) => {
      if (message.type === 'extension') {
        workspace.receive(message.message as GraphRequest);
      }
    },
    subscribe: (listener: (message: EngineMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { connection, workspace };
}

describe('GraphClient', () => {
  it('answers each save with its own file', async () => {
    const { connection } = connect();
    const known = new GraphClient(connection, 'b', 'behavior');
    known.open({ create: 'brain' });
    const unknown = new GraphClient(connection, 'u', 'behavior');
    // A session the workspace does not know: refused, not left pending.
    await expect(unknown.save()).rejects.toThrow();
    const [first, second] = await Promise.all([
      known.save('one.behavior.json'),
      known.save('two.behavior.json'),
    ]);
    expect(first.name).toBe('one.behavior.json');
    expect(second.name).toBe('two.behavior.json');
    known.dispose();
    unknown.dispose();
  });

  it('rejects the saves pending when disposed', async () => {
    const connection = { post: () => undefined, subscribe: () => () => true };
    const client = new GraphClient(connection, 'b', 'behavior');
    const saving = client.save();
    client.dispose();
    await expect(saving).rejects.toThrow('closed');
  });
});
