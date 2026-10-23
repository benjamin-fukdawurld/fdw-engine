import { afterEach, describe, expect, it, vi } from 'vitest';
import { assign, createMachine, setup } from 'xstate';
import {
  persistEditor,
  startEditor,
  type EditorActor,
  type EditorResolver,
  type ModeSpec,
  type SlotId,
  type ToolContext,
  type ToolEvent,
  type ToolSpec,
} from './editorMachine';
import { matchesWhen } from './when';

// A tool that counts its clicks, ends at the third, and keeps what the
// core forwards to it.
function countingTool(id: string, slot: SlotId, when?: string) {
  const contexts: ToolContext[] = [];
  const received: ToolEvent[] = [];
  const spec: ToolSpec = {
    id,
    title: id,
    slot,
    when,
    create: (context) => {
      contexts.push(context);
      return setup({
        types: {
          context: {} as { clicks: number },
          events: {} as { type: 'CLICK' } | ToolEvent,
        },
      }).createMachine({
        context: { clicks: 0 },
        initial: 'counting',
        states: {
          counting: {
            always: {
              guard: ({ context }) => context.clicks >= 3,
              target: 'done',
            },
            on: {
              CLICK: {
                actions: assign({
                  clicks: ({ context }) => context.clicks + 1,
                }),
              },
              'EDITOR.BLUR': { actions: ({ event }) => received.push(event) },
              'EDITOR.VIEW': { actions: ({ event }) => received.push(event) },
            },
          },
          done: { type: 'final' },
        },
      });
    },
  };
  return { spec, contexts, received };
}

function resolverOf(
  tools: ToolSpec[],
  modes: ModeSpec[] = [],
  keys: Record<string, unknown> = {},
): EditorResolver {
  return {
    tool: (id) => tools.find((tool) => tool.id === id),
    mode: (id) => modes.find((mode) => mode.id === id),
    matches: (when) => matchesWhen(when, keys),
    keys: () => keys,
  };
}

const actors: EditorActor[] = [];
function start(resolver: EditorResolver, saved?: unknown) {
  const actor = startEditor(resolver, saved);
  actors.push(actor);
  return actor;
}

const slotsOf = (actor: EditorActor) => actor.getSnapshot().value.slots;
const toolOf = (actor: EditorActor, slot: SlotId) =>
  actor.getSnapshot().children[`tool.${slot}`];
const click = (actor: EditorActor, slot: SlotId) =>
  toolOf(actor, slot)?.send({ type: 'CLICK' });

describe('the machine of the editor', () => {
  afterEach(() => {
    actors.splice(0).forEach((actor) => actor.stop());
  });

  it('starts in the object mode, its slots idle', () => {
    const actor = start(resolverOf([]));
    expect(actor.getSnapshot().value).toEqual({
      window: 'focused',
      mode: 'object',
      slots: { primary: 'idle', secondary: 'idle' },
    });
    expect(actor.getSnapshot().context).toEqual({
      focus: {},
      mode: 'object',
      tools: {},
    });
  });

  it('runs a tool in its slot, and ends the one before', () => {
    const move = countingTool('move', 'primary');
    const rotate = countingTool('rotate', 'primary');
    const actor = start(resolverOf([move.spec, rotate.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    expect(slotsOf(actor)).toEqual({ primary: 'active', secondary: 'idle' });
    expect(actor.getSnapshot().context.tools).toEqual({ primary: 'move' });
    expect(move.contexts[0]?.slot).toBe('primary');
    const first = toolOf(actor, 'primary');
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'rotate' });
    expect(actor.getSnapshot().context.tools.primary).toBe('rotate');
    expect(first?.getSnapshot().status).toBe('stopped');
    expect(toolOf(actor, 'primary')).not.toBe(first);
  });

  it('keeps the tools of the other slots', () => {
    const move = countingTool('move', 'primary');
    const snap = countingTool('snap', 'secondary');
    const actor = start(resolverOf([move.spec, snap.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'snap' });
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    expect(actor.getSnapshot().context.tools).toEqual({
      primary: 'move',
      secondary: 'snap',
    });
    actor.send({ type: 'TOOL.DEACTIVATE', slot: 'primary' });
    expect(slotsOf(actor)).toEqual({ primary: 'idle', secondary: 'active' });
    expect(actor.getSnapshot().context.tools).toEqual({ secondary: 'snap' });
  });

  it('goes back to idle when the tool ends', () => {
    const move = countingTool('move', 'primary');
    const actor = start(resolverOf([move.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    for (let i = 0; i < 3; i++) click(actor, 'primary');
    expect(slotsOf(actor).primary).toBe('idle');
    expect(toolOf(actor, 'primary')).toBeUndefined();

    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    move.contexts[1]?.cancel();
    expect(slotsOf(actor).primary).toBe('idle');
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    move.contexts[2]?.done();
    expect(slotsOf(actor).primary).toBe('idle');
  });

  it('refuses a tool unknown, or whose clause is false', () => {
    const vulkan = countingTool(
      'vulkan',
      'primary',
      'engine.backend == vulkan',
    );
    const actor = start(
      resolverOf([vulkan.spec], [], { 'engine.backend': 'dawn' }),
    );
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'missing' });
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'vulkan' });
    expect(slotsOf(actor)).toEqual({ primary: 'idle', secondary: 'idle' });
    expect(vulkan.contexts).toHaveLength(0);
  });

  it('ends every tool on Escape, whatever they do', () => {
    const move = countingTool('move', 'primary');
    const snap = countingTool('snap', 'secondary');
    const actor = start(resolverOf([move.spec, snap.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'snap' });
    actor.send({ type: 'EDITOR.CANCEL' });
    expect(slotsOf(actor)).toEqual({ primary: 'idle', secondary: 'idle' });
    expect(actor.getSnapshot().children).toEqual({});
  });

  it('ends the tool of a plugin that goes', () => {
    const move = countingTool('move', 'primary');
    const actor = start(resolverOf([move.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    actor.send({ type: 'TOOL.REMOVED', tool: 'other' });
    expect(slotsOf(actor).primary).toBe('active');
    actor.send({ type: 'TOOL.REMOVED', tool: 'move' });
    expect(slotsOf(actor).primary).toBe('idle');
  });

  it('follows the focus, and tells the tools once it has', () => {
    const move = countingTool('move', 'primary');
    const actor = start(resolverOf([move.spec]));
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    actor.send({ type: 'FOCUS.VIEW', area: 'left', view: 'outliner' });
    expect(actor.getSnapshot().context.focus).toEqual({
      area: 'left',
      view: 'outliner',
    });
    actor.send({ type: 'FOCUS.WINDOW', focused: false });
    expect(actor.getSnapshot().value.window).toBe('blurred');
    actor.send({ type: 'FOCUS.WINDOW', focused: true });
    expect(actor.getSnapshot().value.window).toBe('focused');
    expect(move.received).toEqual([
      { type: 'EDITOR.VIEW', area: 'left', view: 'outliner' },
      { type: 'EDITOR.BLUR' },
    ]);
  });

  it('enters the mode of a plugin, with its machine, and leaves it', () => {
    let exit: () => void = () => undefined;
    const paint: ModeSpec = {
      id: 'paint',
      title: 'Paint',
      create: (context) => {
        exit = context.exit;
        return createMachine({ initial: 'brush', states: { brush: {} } });
      },
    };
    const sculpt: ModeSpec = {
      id: 'sculpt',
      title: 'Sculpt',
      when: 'scene.hasMesh',
    };
    const actor = start(resolverOf([], [paint, sculpt]));
    actor.send({ type: 'MODE.SET', mode: 'sculpt' });
    expect(actor.getSnapshot().context.mode).toBe('object');
    actor.send({ type: 'MODE.SET', mode: 'paint' });
    expect(actor.getSnapshot().value.mode).toBe('plugin');
    expect(actor.getSnapshot().context.mode).toBe('paint');
    expect(actor.getSnapshot().children['mode']).toBeTruthy();
    exit();
    expect(actor.getSnapshot().context.mode).toBe('object');
    expect(actor.getSnapshot().children['mode']).toBeUndefined();

    actor.send({ type: 'MODE.SET', mode: 'paint' });
    actor.send({ type: 'MODE.REMOVED', mode: 'paint' });
    expect(actor.getSnapshot().context.mode).toBe('object');
  });

  it('keeps its state and those of its tools as JSON, and restores them', () => {
    const move = countingTool('move', 'primary');
    const tools = [move.spec];
    const paint: ModeSpec = { id: 'paint', title: 'Paint' };
    const actor = start(resolverOf(tools, [paint]));
    actor.send({ type: 'FOCUS.VIEW', area: 'center', view: 'viewport' });
    actor.send({ type: 'MODE.SET', mode: 'paint' });
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    click(actor, 'primary');
    click(actor, 'primary');
    const saved = JSON.parse(JSON.stringify(persistEditor(actor)));

    const restored = start(resolverOf(tools, [paint]), saved);
    expect(restored.getSnapshot().context).toEqual({
      focus: { area: 'center', view: 'viewport' },
      mode: 'paint',
      tools: { primary: 'move' },
    });
    expect(toolOf(restored, 'primary')?.getSnapshot().context).toEqual({
      clicks: 2,
    });
    // Its context made anew, sending to the restored editor.
    move.contexts.at(-1)?.done();
    expect(slotsOf(restored).primary).toBe('idle');
  });

  it('restores as idle the tools and the modes no more registered', () => {
    const move = countingTool('move', 'primary');
    const paint: ModeSpec = { id: 'paint', title: 'Paint' };
    const actor = start(resolverOf([move.spec], [paint]));
    actor.send({ type: 'MODE.SET', mode: 'paint' });
    actor.send({ type: 'TOOL.ACTIVATE', tool: 'move' });
    const saved = JSON.parse(JSON.stringify(persistEditor(actor)));

    const restored = start(resolverOf([]), saved);
    expect(restored.getSnapshot().value).toEqual({
      window: 'focused',
      mode: 'object',
      slots: { primary: 'idle', secondary: 'idle' },
    });
    expect(restored.getSnapshot().context).toMatchObject({
      mode: 'object',
      tools: {},
    });
    expect(restored.getSnapshot().children).toEqual({});
  });

  it('starts anew from a state that does not restore', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const saved of [
      null,
      { value: 'nope' },
      { value: { mode: 'lost' }, context: {}, children: {} },
    ]) {
      const actor = start(resolverOf([]), saved);
      expect(actor.getSnapshot().value).toMatchObject({ mode: 'object' });
    }
    warn.mockRestore();
  });
});
