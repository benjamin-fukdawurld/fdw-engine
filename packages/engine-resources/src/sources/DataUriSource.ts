import { ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import type { ResourceBytes } from '../types';

/**
 * Mounted as `data`, it reads `data:[<mime>][;base64],<payload>` URIs: the
 * store hands it everything after the `data:` scheme.
 */
export class DataUriSource implements ResourceSource {
  read(path: string, options: ReadOptions): Promise<ResourceBytes> {
    if (options.signal.aborted) {
      return Promise.reject(new ResourceError('aborted', path));
    }
    const comma = path.indexOf(',');
    if (comma < 0) {
      return Promise.reject(
        new ResourceError('decode', path, 'Malformed data URI'),
      );
    }
    const meta = path.slice(0, comma);
    const payload = path.slice(comma + 1);
    let bytes: Uint8Array;
    try {
      if (/;base64$/i.test(meta)) {
        const bin = atob(decodeURIComponent(payload));
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }
    } catch (e) {
      // A bad escape or base64 character: a decode error, not a throw.
      return Promise.reject(
        new ResourceError('decode', path, 'Malformed data URI', { cause: e }),
      );
    }
    options.onProgress?.(bytes.byteLength, bytes.byteLength);
    return Promise.resolve(bytes as ResourceBytes);
  }
}
