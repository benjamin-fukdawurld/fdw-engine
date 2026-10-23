import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorShell } from './EditorShell';
import type { EditorHost, EngineConnection } from './host';
import type { EngineMessage, PageMessage } from './protocol';

// A host without engine: the messages of the page are kept, those of the
// engine sent by the test.
function fakeHost() {
  const posted: PageMessage[] = [];
  const listeners = new Set<(message: EngineMessage) => void>();
  const engine: EngineConnection = {
    post: (message) => posted.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const host: EditorHost = {
    engine,
    Viewport: () => <div data-testid="viewport" />,
    about: 'Fake host',
  };
  const send = (message: EngineMessage) =>
    act(() => listeners.forEach((listener) => listener(message)));
  return { host, posted, send, listeners };
}

describe('EditorShell', () => {
  afterEach(cleanup);

  it('shows the viewport of the host and what it tells of itself', () => {
    const { host } = fakeHost();
    render(<EditorShell host={host} />);
    expect(screen.getByTestId('viewport')).toBeTruthy();
    expect(screen.getByText('Fake host')).toBeTruthy();
    expect(screen.getByText('Starting the engine…')).toBeTruthy();
  });

  it('shows the device and the stats of the engine', () => {
    const { host, send } = fakeHost();
    render(<EditorShell host={host} />);
    send({ type: 'ready', device: 'GPU', scenes: ['a', 'b'], scene: 'a' });
    send({ type: 'stats', fps: 60, width: 800, height: 600, info: '' });
    expect(screen.getByText('GPU · 60 fps · 800 × 600')).toBeTruthy();
    send({ type: 'error', message: 'Lost' });
    expect(screen.getByText('Lost')).toBeTruthy();
  });

  it('asks the engine for the scene chosen', () => {
    const { host, posted, send } = fakeHost();
    render(<EditorShell host={host} />);
    send({ type: 'ready', device: 'GPU', scenes: ['a', 'b'], scene: 'a' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(posted).toContainEqual({ type: 'scene', name: 'b' });
  });

  it('stops listening to the engine once unmounted', () => {
    const { host, listeners } = fakeHost();
    const { unmount } = render(<EditorShell host={host} />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
