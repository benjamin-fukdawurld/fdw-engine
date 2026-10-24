import type { SceneContext, SceneFactory } from '@fdw/demo-scenes';
import type { RenderBackend, Surface } from '@fdw/engine-backend';
import type { InputSink } from '@fdw/engine-input';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineMessage, ViewportBounds } from '../protocol';
import { EditorEngine, type EditorEnginePlatform } from './EditorEngine';

// A scene that counts its frames and keeps its context.
function fakeScene(options: { failAt?: number } = {}) {
  const state = {
    frames: 0,
    destroyed: 0,
    context: undefined as SceneContext | undefined,
  };
  const factory: SceneFactory = (_backend, _surface, context) => {
    state.context = context;
    return {
      frame: () => {
        state.frames++;
        if (state.frames === options.failAt) throw new Error('Broken');
      },
      destroy: () => {
        state.destroyed++;
      },
    };
  };
  return { factory, state };
}

// Stopped after each test.
const editors: EditorEngine[] = [];

function setup(
  scenes: Record<string, SceneFactory>,
  options: Partial<EditorEnginePlatform> = {},
) {
  let bounds: ViewportBounds = { x: 0, y: 0, width: 0, height: 0 };
  const surface = { width: 1, height: 1 } as Surface;
  const platform: EditorEnginePlatform = {
    backend: {} as RenderBackend,
    backendName: 'fake',
    device: 'Fake GPU',
    viewport: {
      get bounds() {
        return bounds;
      },
      setBounds: (next) => {
        bounds = next;
      },
    },
    createSurface: vi.fn(async () => surface),
    waitIdle: vi.fn(),
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 1)),
    scenes: Object.fromEntries(
      Object.entries(scenes).map(([name, factory]) => [
        name,
        async () => factory,
      ]),
    ),
    ...options,
  };
  const messages: EngineMessage[] = [];
  const editor = new EditorEngine(platform, Object.keys(scenes)[0] ?? '');
  editors.push(editor);
  editor.connect({ post: (message) => messages.push(message), close: vi.fn() });
  const running = editor.run();
  const show = () =>
    editor.receive({ type: 'bounds', x: 0, y: 0, width: 640, height: 480 });
  return { editor, platform, messages, running, show };
}

const until = (condition: () => boolean) =>
  vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000 });

describe('EditorEngine', () => {
  afterEach(() => {
    editors.forEach((editor) => editor.stop());
    editors.length = 0;
  });

  it('tells the page its device and its scenes', () => {
    const { messages } = setup({
      a: fakeScene().factory,
      b: fakeScene().factory,
    });
    expect(messages[0]).toEqual({
      type: 'ready',
      backend: 'fake',
      device: 'Fake GPU',
      scenes: ['level', 'a', 'b'],
      scene: 'a',
    });
  });

  it('tells the page its level, and runs its commands', async () => {
    const { editor, messages } = setup({ a: fakeScene().factory });
    const level = messages.find((message) => message.type === 'level');
    expect(level).toMatchObject({ name: 'level.scene.json', dirty: false });
    const tree = messages.find((message) => message.type === 'level.nodes');
    const cube =
      tree?.type === 'level.nodes'
        ? tree.nodes.find((node) => node.name === 'cube 1')?.id
        : undefined;
    expect(cube).toBeDefined();
    editor.receive({
      type: 'level.command',
      command: 'select',
      ids: [cube ?? ''],
    });
    expect(messages.at(-2)).toEqual({ type: 'level.selection', ids: [cube] });
    editor.receive({ type: 'level.command', command: 'delete' });
    await until(() =>
      messages.some(
        (message) =>
          message.type === 'level.nodes' &&
          message.removed.includes(cube ?? ''),
      ),
    );
    expect(messages).toContainEqual({
      type: 'level.history',
      undo: 'Delete cube 1',
    });

    // Saved: the file of the level, then no more changes.
    editor.receive({
      type: 'level.save',
      format: 'fdw-scene',
      name: 'a.scene.json',
    });
    await until(() =>
      messages.some((message) => message.type === 'level.file'),
    );
    editor.receive({ type: 'level.saved', name: 'a.scene.json' });
    expect(messages.at(-1)).toMatchObject({
      type: 'level',
      name: 'a.scene.json',
      dirty: false,
    });

    // A new level: the sample one, whole.
    messages.length = 0;
    editor.receive({ type: 'level.new' });
    await until(() => messages.some((message) => message.type === 'level'));
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'level.nodes', reset: true }),
    );
  });

  it('tells the page why its backend is a fallback', () => {
    const { messages } = setup(
      { a: fakeScene().factory },
      { backendName: 'dawn', fallback: 'vulkan: No device' },
    );
    expect(messages[0]).toMatchObject({
      type: 'ready',
      backend: 'dawn',
      fallback: 'vulkan: No device',
    });
  });

  it('shows the first scene once the viewport has an area', async () => {
    const a = fakeScene();
    const { platform, show } = setup({ a: a.factory });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(platform.createSurface).not.toHaveBeenCalled();
    show();
    await until(() => a.state.frames > 2);
  });

  it('draws no frames while hidden', async () => {
    const a = fakeScene();
    const { editor, show } = setup({ a: a.factory });
    show();
    await until(() => a.state.frames > 0);
    editor.setVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frames = a.state.frames;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.state.frames).toBe(frames);
  });

  it('replaces the scene once the next one is loaded', async () => {
    const a = fakeScene();
    const b = fakeScene();
    const { editor, platform, messages, show } = setup({
      a: a.factory,
      b: b.factory,
    });
    show();
    await until(() => a.state.frames > 0);
    editor.receive({ type: 'scene', name: 'b' });
    await until(() => b.state.frames > 0);
    expect(a.state.destroyed).toBe(1);
    expect(platform.waitIdle).toHaveBeenCalled();
    expect(messages).toContainEqual({ type: 'loading', scene: 'b' });
    expect(messages).toContainEqual({ type: 'pointerLock', locked: false });
  });

  it('reports an unknown scene and a scene that fails', async () => {
    const a = fakeScene({ failAt: 2 });
    const { editor, messages, show } = setup({ a: a.factory });
    show();
    await until(() => a.state.destroyed === 1);
    expect(messages).toContainEqual({ type: 'error', message: 'a: Broken' });
    editor.receive({ type: 'scene', name: 'nope' });
    await until(() =>
      messages.some(
        (m) => m.type === 'error' && m.message === 'No scene named nope',
      ),
    );
  });

  it('replays the inputs of the page in the scene', async () => {
    const a = fakeScene();
    const { editor, show } = setup({ a: a.factory });
    show();
    await until(() => a.state.frames > 0);
    const keyDown = vi.fn();
    a.state.context?.input?.attach({ keyDown } as unknown as InputSink);
    editor.receive({ type: 'input', method: 'keyDown', args: ['KeyW', 'w'] });
    expect(keyDown).toHaveBeenCalledWith('KeyW', 'w');
  });

  it('gives the scenes the inputs of the platform, without replay', async () => {
    const a = fakeScene();
    const b = fakeScene();
    const input = {
      attach: vi.fn(),
      detach: vi.fn(),
      readGamepads: () => 0,
      setPointerLock: vi.fn(),
    };
    const { editor, messages, show } = setup(
      { a: a.factory, b: b.factory },
      { input },
    );
    show();
    await until(() => a.state.frames > 0);
    expect(a.state.context?.input).toBe(input);
    editor.receive({ type: 'scene', name: 'b' });
    await until(() => b.state.frames > 0);
    expect(b.state.context?.input).toBe(input);
    // The lock of the scene released on the source itself.
    expect(input.setPointerLock).toHaveBeenCalledWith(false);
    expect(messages.some((m) => m.type === 'pointerLock')).toBe(false);
  });

  it('ends its loop on stop, and destroys the scene after', async () => {
    const a = fakeScene();
    const { editor, running, show } = setup({ a: a.factory });
    show();
    await until(() => a.state.frames > 0);
    editor.stop();
    await running;
    expect(a.state.destroyed).toBe(0);
    editor.destroy();
    expect(a.state.destroyed).toBe(1);
  });
});
