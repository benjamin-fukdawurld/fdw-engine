import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from './host';
import type { PageMessage } from './protocol';
import { RemoteViewport } from './RemoteViewport';

function fakeEngine() {
  const posted: PageMessage[] = [];
  const engine: EngineConnection = {
    post: (message) => posted.push(message),
    subscribe: () => () => undefined,
  };
  const holes = () => posted.filter((message) => message.type === 'holes');
  return { engine, posted, holes };
}

describe('RemoteViewport', () => {
  afterEach(cleanup);

  // A viewport unmounted under a menu (the layout reset from the View
  // menu) left its hole in the window: the next one did not clear it.
  it('sends its holes at once, and none once unmounted', async () => {
    const { engine, holes } = fakeEngine();
    const { unmount } = render(<RemoteViewport engine={engine} />);
    await waitFor(() =>
      expect(holes()).toEqual([{ type: 'holes', holes: [] }]),
    );
    unmount();
    expect(holes()).toHaveLength(2);
    expect(holes()[1]).toEqual({ type: 'holes', holes: [] });
  });
});
