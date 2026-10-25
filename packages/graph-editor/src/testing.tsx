import {
  EditorShell,
  type EditorPlugin,
  type EditorRuntime,
  type EngineMessage,
  type PageMessage,
} from '@fdw/editor-ui';
import { fakeHost, readyMessage } from '@fdw/editor-ui/testing';
import {
  type GraphRequest,
  type GraphTarget,
  GraphWorkspace,
} from '@fdw/engine-graph-editing';
import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { graphsExtensionId } from './client';

/**
 * The shell with a fake host whose engine is a GraphWorkspace on targets
 * (`@fdw/graph-editor/testing`): the plugins of the graphs talk to it as
 * to the extension of a real engine. `frame` runs it (the compilations,
 * the live states), in `act`.
 */
export async function renderGraphEditor(
  plugins: readonly EditorPlugin[],
  targets: readonly GraphTarget[] = [],
) {
  const fake = fakeHost({}, plugins);
  const send = (message: EngineMessage) => act(() => fake.send(message));
  const workspace = new GraphWorkspace({
    post: (message, data) =>
      fake.send({
        type: 'extension',
        extension: graphsExtensionId,
        message,
        ...(data && { data }),
      }),
  });
  workspace.setTargets(targets);
  const host = {
    ...fake.host,
    engine: {
      ...fake.host.engine,
      post: (message: PageMessage) => {
        fake.host.engine.post(message);
        if (
          message.type === 'extension' &&
          message.extension === graphsExtensionId
        ) {
          workspace.receive(message.message as GraphRequest);
        }
      },
    },
  };
  let runtime: EditorRuntime | undefined;
  render(<EditorShell host={host} onRuntime={(made) => (runtime = made)} />, {
    wrapper: StrictMode,
  });
  await screen.findByTestId('viewport');
  if (!runtime) throw new Error('No runtime');
  send({ ...readyMessage, scenes: ['level'], scene: 'level' });
  let time = 0;
  const frame = (seconds = 0.2) =>
    act(() => {
      time += seconds;
      workspace.frame(time);
    });
  return { ...fake, host, runtime, workspace, send, frame };
}

/**
 * What jsdom lacks for the canvas and the previews: PointerEvent (the
 * mouse events, with the fields of a pointer), and the 2D context of a
 * canvas (none: nothing drawn).
 */
export function stubGraphDom(): void {
  globalThis.PointerEvent ??= class PointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  } as typeof globalThis.PointerEvent;
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as HTMLCanvasElement['getContext'];
}
