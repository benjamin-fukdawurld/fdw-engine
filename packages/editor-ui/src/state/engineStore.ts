import { createStore } from '@xstate/store';
import type { EngineConnection } from '../host';
import type { EngineMessage } from '../protocol';

type Stats = Extract<EngineMessage, { type: 'stats' }>;

/** A line of the console. */
export interface LogEntry {
  readonly id: number;
  readonly time: Date;
  readonly level: 'info' | 'error';
  readonly text: string;
}

// The last lines kept.
const logLength = 200;

/**
 * What the engine tells of itself, for the bars and the panels: runtime
 * state, never kept, from its messages.
 */
export interface EngineStoreContext {
  readonly device: string;
  readonly backend: string;
  readonly fallback?: string;
  readonly scenes: readonly string[];
  readonly scene: string;
  readonly loading: boolean;
  readonly stats?: Stats;
  readonly error: string;
  readonly log: readonly LogEntry[];
  readonly nextLog: number;
}

function write(
  context: EngineStoreContext,
  level: LogEntry['level'],
  text: string,
): EngineStoreContext {
  return {
    ...context,
    log: [
      ...context.log.slice(-(logLength - 1)),
      { id: context.nextLog, time: new Date(), level, text },
    ],
    nextLog: context.nextLog + 1,
  };
}

export function createEngineStore() {
  return createStore({
    context: {
      device: '',
      backend: '',
      scenes: [],
      scene: '',
      loading: false,
      error: '',
      log: [],
      nextLog: 0,
    } as EngineStoreContext,
    on: {
      message: (context, { message }: { message: EngineMessage }) => {
        switch (message.type) {
          case 'ready': {
            const ready = write(
              {
                ...context,
                device: message.device,
                backend: message.backend,
                fallback: message.fallback,
                scenes: message.scenes,
                scene: message.scene,
              },
              'info',
              `Engine ready: ${message.backend} · ${message.device}`,
            );
            return message.fallback
              ? write(
                  ready,
                  'error',
                  `${message.backend} as a fallback: ${message.fallback}`,
                )
              : ready;
          }
          case 'loading':
            return write(
              { ...context, loading: true, error: '' },
              'info',
              `Loading ${message.scene}`,
            );
          case 'stats':
            return { ...context, stats: message, loading: false };
          case 'error':
            return write(
              { ...context, error: message.message, loading: false },
              'error',
              message.message,
            );
          default:
            return context;
        }
      },
      chooseScene: (context, { scene }: { scene: string }) => ({
        ...context,
        scene,
      }),
    },
  });
}

export type EngineStore = ReturnType<typeof createEngineStore>;

/** Writes the messages of the engine in the store; returns the unsubscription. */
export function connectEngineStore(
  engine: EngineConnection,
  store: EngineStore,
): () => void {
  return engine.subscribe((message) => store.trigger.message({ message }));
}
