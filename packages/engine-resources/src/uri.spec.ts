import { describe, expect, it } from 'vitest';
import {
  extname,
  formatUri,
  normalizePath,
  parseUri,
  resolvePath,
} from './uri';

describe('uri', () => {
  const mounted = (s: string) => s === 'pack' || s === 'http';

  it('splits scheme, path and fragment', () => {
    expect(parseUri('pack:trees/oak.glb#mesh/2', mounted)).toEqual({
      scheme: 'pack',
      path: 'trees/oak.glb',
      fragment: 'mesh/2',
    });
    expect(parseUri('model.glb#mesh/2', mounted)).toEqual({
      path: 'model.glb',
      fragment: 'mesh/2',
    });
  });

  it('only recognizes mounted schemes', () => {
    expect(parseUri('https://host/a.png', mounted)).toEqual({
      path: 'https://host/a.png',
      fragment: undefined,
    });
    expect(parseUri('C:/models/a.obj', mounted).scheme).toBeUndefined();
  });

  it('formats back', () => {
    expect(formatUri({ scheme: 'a', path: 'b/c', fragment: 'd' })).toBe(
      'a:b/c#d',
    );
    expect(formatUri({ path: 'b' })).toBe('b');
  });

  it('normalizes paths', () => {
    expect(normalizePath('a/./b/../c//d')).toBe('a/c/d');
    expect(normalizePath('a\\b\\c')).toBe('a/b/c');
    expect(normalizePath('../a')).toBe('../a');
    expect(normalizePath('/a/../../b')).toBe('/b');
    expect(normalizePath('https://h.com/a/../b/c.png')).toBe(
      'https://h.com/b/c.png',
    );
  });

  it('resolves relative paths against a resource', () => {
    expect(resolvePath('models/oak.gltf', 'textures/bark.png')).toBe(
      'models/textures/bark.png',
    );
    expect(resolvePath('models/oak.gltf', '../shared/x.png')).toBe(
      'shared/x.png',
    );
    expect(resolvePath('oak.gltf', 'bark.png')).toBe('bark.png');
    expect(resolvePath('models/oak.gltf', '/abs/x.png')).toBe('/abs/x.png');
    expect(resolvePath('https://h.com/m/oak.gltf', '../t/b.png')).toBe(
      'https://h.com/t/b.png',
    );
  });

  it('reads extensions', () => {
    expect(extname('a/b/Model.GLB')).toBe('glb');
    expect(extname('a.b/c')).toBe('');
    expect(extname('.hidden')).toBe('');
    expect(extname('x.png?v=3')).toBe('png');
  });
});
