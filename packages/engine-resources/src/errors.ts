export type ResourceErrorCode =
  | 'not-found'
  | 'decode'
  | 'unsupported'
  | 'aborted'
  | 'dependency'
  | 'io';

export interface ResourceErrorOptions {
  readonly cause?: unknown;
  /** The chain of URIs from the failing resource down to the root cause. */
  readonly path?: readonly string[];
  /** The failure is a dependency cycle: `path` is the cycle itself. */
  readonly cycle?: boolean;
}

export class ResourceError extends Error {
  readonly code: ResourceErrorCode;
  readonly uri: string;
  /** `oak.glb → bark.png`: the resource, then the dependencies that failed. */
  readonly path: readonly string[];
  readonly cycle: boolean;

  constructor(
    code: ResourceErrorCode,
    uri: string,
    message?: string,
    options?: ResourceErrorOptions
  ) {
    super(message ?? `${code}: ${uri}`, { cause: options?.cause });
    this.name = 'ResourceError';
    this.code = code;
    this.uri = uri;
    this.path = options?.path ?? [uri];
    this.cycle = options?.cycle ?? false;
  }
}

export const isAbortError = (e: unknown): boolean =>
  (e instanceof Error && e.name === 'AbortError') ||
  (e instanceof ResourceError && e.code === 'aborted');
