import { createStore } from '@xstate/store';
import { describe, expect, it, vi } from 'vitest';
import { createContextKeys } from './contextKeys';
import { compileWhen, matchesWhen } from './when';

const keys = {
  'engine.backend': 'vulkan',
  'scene.hasSelection': true,
  'tool.primary': 'acme.move',
  'editor.count': 2,
  'editor.empty': '',
};

const when = (source: string) => compileWhen(source)(keys);

describe('when clauses', () => {
  it('reads a key as true if its value is truthy', () => {
    expect(when('scene.hasSelection')).toBe(true);
    expect(when('editor.empty')).toBe(false);
    expect(when('missing')).toBe(false);
    expect(when('true')).toBe(true);
    expect(when('false')).toBe(false);
    expect(when('')).toBe(true);
  });

  it('compares a key to a value, bare or quoted', () => {
    expect(when('engine.backend == vulkan')).toBe(true);
    expect(when("engine.backend == 'dawn'")).toBe(false);
    expect(when('engine.backend != "dawn"')).toBe(true);
    expect(when('tool.primary == acme.move')).toBe(true);
    expect(when('editor.count == 2')).toBe(true);
    expect(when('scene.hasSelection == true')).toBe(true);
    expect(when('missing != vulkan')).toBe(true);
  });

  it('combines with !, && before ||, and parentheses', () => {
    expect(when('!missing')).toBe(true);
    expect(when('!!scene.hasSelection')).toBe(true);
    expect(
      when('missing && scene.hasSelection || engine.backend == vulkan'),
    ).toBe(true);
    expect(
      when('missing && (scene.hasSelection || engine.backend == vulkan)'),
    ).toBe(false);
    expect(when('!(engine.backend == dawn) && scene.hasSelection')).toBe(true);
  });

  it('refuses a clause that is not valid', () => {
    for (const source of [
      'a &&',
      '(a',
      'a == ',
      "a == 'b",
      'a b',
      'a $ b',
      ')',
    ]) {
      expect(() => compileWhen(source), source).toThrow(SyntaxError);
    }
  });

  it('is false when not valid, true without a clause', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(matchesWhen('a &&', { a: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(matchesWhen('a &&', { a: true })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(matchesWhen(undefined, {})).toBe(true);
    warn.mockRestore();
  });
});

describe('the context keys', () => {
  const sourceStore = () =>
    createStore({
      context: { backend: '', fps: 0 },
      on: {
        ready: (context, event: { backend: string }) => ({
          ...context,
          backend: event.backend,
        }),
        stats: (context, event: { fps: number }) => ({
          ...context,
          fps: event.fps,
        }),
      },
    });

  it('are derived again when a source changes, and tell it', () => {
    const store = sourceStore();
    const contextKeys = createContextKeys([store], () => ({
      'engine.backend': store.getSnapshot().context.backend || undefined,
    }));
    const listener = vi.fn();
    contextKeys.subscribe(listener);
    const before = contextKeys.values();
    // A change that changes no key.
    store.trigger.stats({ fps: 60 });
    expect(listener).not.toHaveBeenCalled();
    expect(contextKeys.values()).toBe(before);
    store.trigger.ready({ backend: 'vulkan' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(contextKeys.matches('engine.backend == vulkan')).toBe(true);
    contextKeys.dispose();
    store.trigger.ready({ backend: 'dawn' });
    expect(contextKeys.values()['engine.backend']).toBe('vulkan');
  });

  it('take the keys set by the plugins, until disposed', () => {
    const contextKeys = createContextKeys([], () => ({
      'editor.mode': 'object',
    }));
    const first = contextKeys.set('acme.painting', true);
    const second = contextKeys.set('editor.mode', 'acme.paint');
    expect(
      contextKeys.matches('acme.painting && editor.mode == acme.paint'),
    ).toBe(true);
    second.dispose();
    expect(contextKeys.values()['editor.mode']).toBe('object');
    first.dispose();
    expect(contextKeys.values()).toEqual({ 'editor.mode': 'object' });
  });
});
