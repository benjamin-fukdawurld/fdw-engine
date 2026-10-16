import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ResourceSource } from '@fdw/engine-resources';
import type { FileSource } from './FileSource';

export interface FileWatchOptions {
  /** Keeps the process alive while watching. False by default. */
  readonly persistent?: boolean;
}

/**
 * Adds `watch` to a `FileSource`, with `fs.watch`. One watcher per directory
 * watched, shared by its files. The store regroups a burst of events (an
 * editor saves in several steps) into one reload.
 *
 * `fs.watch` depends on the platform and the file system (network drives
 * may report nothing): `store.reload(uri)` stays the explicit way.
 */
export function withFileWatch(
  source: FileSource,
  { persistent = false }: FileWatchOptions = {}
): ResourceSource {
  const directories = new Map<
    string,
    { watcher: FSWatcher; files: Map<string, Set<() => void>> }
  >();

  const unwatch = (dir: string, name: string, onChange: () => void) => {
    const watched = directories.get(dir);
    const listeners = watched?.files.get(name);
    if (!watched || !listeners) return;
    listeners.delete(onChange);
    if (listeners.size === 0) watched.files.delete(name);
    if (watched.files.size === 0) {
      watched.watcher.close();
      directories.delete(dir);
    }
  };

  return {
    read: (path, options) => source.read(path, options),
    stat: (path) => source.stat(path),
    list: (prefix) => source.list(prefix),
    watch(path, onChange) {
      const file = source.filePath(path);
      const dir = dirname(file);
      const name = basename(file);
      let watched = directories.get(dir);
      if (!watched) {
        const files = new Map<string, Set<() => void>>();
        let watcher: FSWatcher;
        try {
          watcher = fsWatch(dir, { persistent }, (_event, changed) => {
            // Without a name (some platforms), every file may have changed.
            const targets = changed
              ? [files.get(changed.toString())]
              : [...files.values()];
            for (const listeners of targets)
              for (const cb of [...(listeners ?? [])]) cb();
          });
        } catch {
          return () => undefined; // a missing directory: nothing to watch
        }
        watcher.on('error', () => {
          watcher.close();
          directories.delete(dir);
        });
        directories.set(dir, (watched = { watcher, files }));
      }
      let listeners = watched.files.get(name);
      if (!listeners) watched.files.set(name, (listeners = new Set()));
      listeners.add(onChange);
      return () => unwatch(dir, name, onChange);
    },
  };
}
