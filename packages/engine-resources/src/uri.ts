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

/**
 * Collapses `.`, `..`, `//` and backslashes. An URL origin is kept as is.
 * `rooted` treats a relative path as relative to a root it cannot leave (the
 * root of a scheme): a leading `..` is dropped instead of kept.
 */
export function normalizePath(path: string, rooted = false): string {
  path = path.replace(/\\/g, '/');
  const origin = URL_PREFIX.exec(path)?.[0] ?? '';
  let rest = path.slice(origin.length);
  const absolute = origin !== '' || rest.startsWith('/');
  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute && !rooted) out.push('..');
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

/**
 * Resolves `relative` against the path of a resource (a glTF and its
 * textures). `rooted` bounds `..` at the root, as in normalizePath.
 */
export function resolvePath(
  basePath: string,
  relative: string,
  rooted = false,
): string {
  if (relative.startsWith('/') || URL_PREFIX.test(relative)) {
    return normalizePath(relative, rooted);
  }
  const dir = dirname(basePath);
  return normalizePath(dir ? `${dir}/${relative}` : relative, rooted);
}

/**
 * The path of `path` relative to the folder of `basePath`: the inverse of
 * resolvePath (`levels/forest.json`, `models/fir.glb` → `../models/fir.glb`).
 * Paths of different origins stay as they are.
 */
export function relativePath(basePath: string, path: string): string {
  const from = normalizePath(dirname(basePath));
  const to = normalizePath(path);
  const origin = (p: string) => URL_PREFIX.exec(p)?.[0] ?? '';
  if (
    origin(from) !== origin(to) ||
    from.startsWith('/') !== to.startsWith('/') ||
    from.split('/')[0] === '..'
  ) {
    return to;
  }
  const a = from.slice(origin(from).length).split('/').filter(Boolean);
  const b = to.slice(origin(to).length).split('/').filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common])
    common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}
