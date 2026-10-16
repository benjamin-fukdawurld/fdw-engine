import { normalizePath, type ResourceSource } from '@fdw/engine-resources';

/** Something that announces the paths that changed: a dev server, a socket. */
export interface ChangeChannel {
  subscribe(listener: (path: string) => void): () => void;
}

const sameFile = (a: string, b: string): boolean =>
  normalizePath(a).replace(/^\/+/, '') === normalizePath(b).replace(/^\/+/, '');

/** Adds `watch` to a source from a channel of changed paths (HMR). */
export function withChangeChannel(source: ResourceSource, channel: ChangeChannel): ResourceSource {
  return {
    read: (path, options) => source.read(path, options),
    stat: source.stat?.bind(source),
    list: source.list?.bind(source),
    watch(path, onChange) {
      return channel.subscribe((changed) => {
        if (sameFile(changed, path)) onChange();
      });
    },
  };
}

/**
 * The subset of Vite's `import.meta.hot` used here. The dev server sends the
 * event, from a plugin's `server.watcher.on('change', …)` and `server.ws.send`
 * (static files do not trigger HMR by themselves).
 */
export interface HotContext {
  on(event: string, callback: (data: any) => void): void;
  off?(event: string, callback: (data: any) => void): void;
}

/** The payload is the changed path, or `{ path }`. */
export function hotChannel(hot: HotContext, event = 'fdw:resource-changed'): ChangeChannel {
  return {
    subscribe(listener) {
      const callback = (data: unknown) => {
        const path = typeof data === 'string' ? data : (data as { path?: string } | null)?.path;
        if (typeof path === 'string') listener(path);
      };
      hot.on(event, callback);
      return () => hot.off?.(event, callback);
    },
  };
}

export interface PollingOptions {
  /** Time between two checks of a path, 1000 ms by default. */
  readonly intervalMs?: number;
}

/**
 * Adds `watch` to a source that can `stat`, by comparing revisions (ETag,
 * Last-Modified). Needs no cooperation from the server, at the price of one
 * request per watched path and interval.
 */
export function withPolling(source: ResourceSource, { intervalMs = 1000 }: PollingOptions = {}): ResourceSource {
  const stat = source.stat?.bind(source);
  if (!stat) throw new Error('withPolling needs a source that implements stat()');
  return {
    read: (path, options) => source.read(path, options),
    stat,
    list: source.list?.bind(source),
    watch(path, onChange) {
      let last: string | undefined;
      let busy = false;
      let stopped = false;
      const check = async () => {
        if (busy || stopped) return;
        busy = true;
        try {
          const { revision } = await stat(path);
          if (stopped || revision === undefined) return;
          if (last !== undefined && revision !== last) onChange();
          last = revision;
        } catch {
          // Missing or unreachable for now: the next check will tell.
        } finally {
          busy = false;
        }
      };
      void check(); // the baseline
      const timer = setInterval(check, intervalMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
