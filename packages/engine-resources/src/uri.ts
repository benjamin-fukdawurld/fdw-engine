export interface ParsedUri {
  readonly scheme?: string;
  readonly path: string;
  readonly fragment?: string;
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s;
const URL_PREFIX = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/]*/;

/**
 * Splits `scheme:path#fragment`. A scheme is only recognized when
 * `isScheme` accepts it, so `https://host/a.png` is a plain path when no
 * `https` source is mounted.
 */
export function parseUri(
  uri: string,
  isScheme: (scheme: string) => boolean = () => false,
): ParsedUri {
  let fragment: string | undefined;
  const hash = uri.indexOf('#');
  if (hash >= 0) {
    fragment = uri.slice(hash + 1);
    uri = uri.slice(0, hash);
  }
  const match = SCHEME.exec(uri);
  if (match && isScheme(match[1])) {
    return { scheme: match[1], path: match[2], fragment };
  }
  return { path: uri, fragment };
}

export function formatUri({ scheme, path, fragment }: ParsedUri): string {
  return `${scheme !== undefined ? scheme + ':' : ''}${path}${
    fragment !== undefined ? '#' + fragment : ''
  }`;
}

/** Collapses `.`, `..`, `//` and backslashes. An URL origin is kept as is. */
export function normalizePath(path: string): string {
  path = path.replace(/\\/g, '/');
  const origin = URL_PREFIX.exec(path)?.[0] ?? '';
  let rest = path.slice(origin.length);
  const absolute = origin !== '' || rest.startsWith('/');
  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  rest = out.join('/');
  if (origin !== '') return rest ? `${origin}/${rest}` : origin;
  return absolute ? '/' + rest : rest;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** The lower-case extension of a path, without the dot, and ignoring a query. */
export function extname(path: string): string {
  const clean = path.split(/[?#]/, 1)[0];
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Resolves `relative` against the path of a resource (a glTF and its textures). */
export function resolvePath(basePath: string, relative: string): string {
  if (relative.startsWith('/') || URL_PREFIX.test(relative)) {
    return normalizePath(relative);
  }
  const dir = dirname(basePath);
  return normalizePath(dir ? `${dir}/${relative}` : relative);
}
