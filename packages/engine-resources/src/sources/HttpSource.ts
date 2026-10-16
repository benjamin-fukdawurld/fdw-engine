import { isAbortError, ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import type { ResourceBytes } from '../types';

export interface HttpSourceOptions {
  /** Prepended to relative paths: `/`, `/assets/`, `https://cdn.example.com/`. */
  readonly base?: string;
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  /** For tests and platforms with a custom fetch. */
  readonly fetch?: typeof fetch;
}

const ABSOLUTE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//;

export class HttpSource implements ResourceSource {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpSourceOptions = {}) {
    const base = options.base ?? '';
    this.base = base === '' || base.endsWith('/') ? base : base + '/';
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  private url(path: string): string {
    if (ABSOLUTE.test(path)) return path;
    return this.base + path.replace(/^\/+/, '');
  }

  private init(signal?: AbortSignal, method = 'GET'): RequestInit {
    return {
      method,
      signal,
      headers: this.options.headers,
      credentials: this.options.credentials,
    };
  }

  private fail(path: string, e: unknown): never {
    if (isAbortError(e))
      throw new ResourceError('aborted', path, undefined, { cause: e });
    if (e instanceof ResourceError) throw e;
    throw new ResourceError('io', path, `Network error: ${path}`, { cause: e });
  }

  async read(
    path: string,
    { signal, onProgress }: ReadOptions
  ): Promise<ResourceBytes> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url(path), this.init(signal));
    } catch (e) {
      this.fail(path, e);
    }
    if (response.status === 404) throw new ResourceError('not-found', path);
    if (!response.ok) {
      throw new ResourceError(
        'io',
        path,
        `HTTP ${response.status} ${response.statusText}: ${path}`
      );
    }
    try {
      const length = Number(response.headers.get('content-length'));
      // Content-Length is the encoded size: when the body is compressed, the
      // decoded count can exceed it, so it is only a hint.
      const total = length > 0 ? length : undefined;
      if (!response.body) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        onProgress?.(buffer.byteLength, buffer.byteLength);
        return buffer as ResourceBytes;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(total ? Math.min(loaded, total) : loaded, total);
      }
      const out = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      onProgress?.(loaded, loaded);
      return out as ResourceBytes;
    } catch (e) {
      this.fail(path, e);
    }
  }

  async stat(path: string): Promise<{ size?: number; revision?: string }> {
    let response: Response;
    try {
      response = await this.fetchFn(
        this.url(path),
        this.init(undefined, 'HEAD')
      );
    } catch (e) {
      this.fail(path, e);
    }
    if (response.status === 404) throw new ResourceError('not-found', path);
    if (!response.ok)
      throw new ResourceError('io', path, `HTTP ${response.status}: ${path}`);
    const length = Number(response.headers.get('content-length'));
    return {
      size: length > 0 ? length : undefined,
      revision:
        response.headers.get('etag') ??
        response.headers.get('last-modified') ??
        undefined,
    };
  }
}
