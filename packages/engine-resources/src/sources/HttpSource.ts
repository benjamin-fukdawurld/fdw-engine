import { isAbortError, ResourceError } from '../errors';
import type { ReadOptions, ResourceSource } from '../ResourceSource';
import type { ResourceBytes } from '../types';
import { normalizePath } from '../uri';

export interface HttpSourceOptions {
  /** Prepended to relative paths: `/`, `/assets/`, `https://cdn.example.com/`. */
  readonly base?: string;
  /** Sent only to the allowed origins: a scene may name any absolute URL. */
  readonly headers?: HeadersInit;
  /** Like `headers`, applied only to the allowed origins. */
  readonly credentials?: RequestCredentials;
  /**
   * The origins (`https://cdn.example.com`) that receive `headers` and
   * `credentials`. By default the origin of `base`, and the page's own.
   */
  readonly allowedOrigins?: readonly string[];
  /** For tests and platforms with a custom fetch. */
  readonly fetch?: typeof fetch;
}

const ABSOLUTE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//;

function pageOrigin(): string | undefined {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin;
}

/** The origin of an absolute URL (or of one relative to the page), if any. */
function originOf(url: string): string | undefined {
  if (url === '') return undefined;
  try {
    const origin = new URL(url, pageOrigin()).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

export class HttpSource implements ResourceSource {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly options: HttpSourceOptions = {}) {
    const base = options.base ?? '';
    this.base = base === '' || base.endsWith('/') ? base : base + '/';
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
    const origins = options.allowedOrigins ?? [this.base, pageOrigin() ?? ''];
    this.allowed = new Set(
      origins.map((o) => originOf(o)).filter((o) => o !== undefined),
    );
  }

  private url(path: string): string {
    if (ABSOLUTE.test(path)) return path;
    // `..` cannot climb above `base`.
    return this.base + normalizePath(path, true).replace(/^\/+/, '');
  }

  private init(url: string, signal?: AbortSignal, method = 'GET'): RequestInit {
    // A URL relative to the page stays on its origin; an absolute one gets
    // the configured headers only when its origin is allowed.
    const origin = ABSOLUTE.test(url) ? originOf(url) : undefined;
    const trusted =
      !ABSOLUTE.test(url) || (origin !== undefined && this.allowed.has(origin));
    return {
      method,
      signal,
      headers: trusted ? this.options.headers : undefined,
      credentials: trusted ? this.options.credentials : undefined,
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
    { signal, onProgress }: ReadOptions,
  ): Promise<ResourceBytes> {
    let response: Response;
    try {
      const url = this.url(path);
      response = await this.fetchFn(url, this.init(url, signal));
    } catch (e) {
      this.fail(path, e);
    }
    if (response.status === 404) throw new ResourceError('not-found', path);
    if (!response.ok) {
      throw new ResourceError(
        'io',
        path,
        `HTTP ${response.status} ${response.statusText}: ${path}`,
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
      const url = this.url(path);
      response = await this.fetchFn(url, this.init(url, undefined, 'HEAD'));
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
