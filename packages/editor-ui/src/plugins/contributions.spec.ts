import { describe, expect, it, vi } from 'vitest';
import {
  CommandService,
  findKeybinding,
  isEditable,
  keybindingLabel,
  keyOfEvent,
  menuGroups,
  MenuRegistry,
  normalizeKey,
  type KeybindingSpec,
} from './contributions';

describe('the keys', () => {
  it('writes a key in a single form', () => {
    expect(normalizeKey('Shift+Ctrl+P')).toBe('ctrl+shift+p');
    expect(normalizeKey('cmd+alt+Esc')).toBe('alt+meta+escape');
    expect(normalizeKey('F1')).toBe('f1');
  });

  it('reads the key of an event, letters by their place', () => {
    const event = (init: KeyboardEventInit) =>
      new KeyboardEvent('keydown', init);
    expect(
      keyOfEvent(
        event({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }),
      ),
    ).toBe('ctrl+shift+p');
    // Alt+M gives µ on some layouts.
    expect(keyOfEvent(event({ key: 'µ', code: 'KeyM', altKey: true }))).toBe(
      'alt+m',
    );
    expect(keyOfEvent(event({ key: 'Escape', code: 'Escape' }))).toBe('escape');
    expect(
      keyOfEvent(event({ key: 'Shift', code: 'ShiftLeft' })),
    ).toBeUndefined();
  });

  it('finds the last keybinding whose clause holds', () => {
    const bindings: KeybindingSpec[] = [
      { id: 'a#0', plugin: 'a', command: 'a.run', key: 'm' },
      { id: 'b#0', plugin: 'b', command: 'b.run', key: 'M', when: 'b.on' },
      { id: 'a#1', plugin: 'a', command: 'a.save', key: 'ctrl+s' },
    ];
    const on = (when: string | undefined) => when !== 'b.on';
    expect(findKeybinding(bindings, 'm', () => true, false)?.command).toBe(
      'b.run',
    );
    expect(findKeybinding(bindings, 'm', on, false)?.command).toBe('a.run');
    // In a text field, a key that types is left to it.
    expect(findKeybinding(bindings, 'm', () => true, true)).toBeUndefined();
    expect(findKeybinding(bindings, 'ctrl+s', () => true, true)?.command).toBe(
      'a.save',
    );
    expect(keybindingLabel(bindings, 'a.save')).toBe('Ctrl+S');
  });

  it('knows the elements that take the text typed', () => {
    const input = document.createElement('input');
    expect(isEditable(input)).toBe(true);
    input.type = 'checkbox';
    expect(isEditable(input)).toBe(false);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(document.createElement('div'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('MenuRegistry', () => {
  it('sorts the items of a menu by group, then by order', () => {
    const menus = new MenuRegistry();
    const listener = vi.fn();
    menus.subscribe(listener);
    menus.append('view', { command: 'c', group: '2' });
    const b = menus.append('view', { command: 'b', group: '1', order: 2 });
    menus.append('view', { command: 'a', group: '1', order: 1 });
    menus.append('other', { command: 'x' });
    const items = menus.items('view');
    expect(items.map((item) => 'command' in item && item.command)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(menus.items('view')).toBe(items);
    expect(menuGroups(items).map((group) => group.length)).toEqual([2, 1]);
    b.dispose();
    b.dispose();
    expect(menus.items('view')).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(5);
  });
});

describe('CommandService', () => {
  const service = (enabled = true) => {
    const activate = vi.fn(async () => undefined);
    const commands = new CommandService({
      activate,
      matches: (when) => enabled || when === undefined,
    });
    return { commands, activate };
  };

  it('runs the handler of a command, with its arguments', async () => {
    const { commands, activate } = service();
    commands.specs.register({ id: 'a.run', title: 'Run', plugin: 'a' });
    const handler = vi.fn((value: unknown) => value);
    commands.registerHandler('a.run', handler);
    expect(await commands.execute('a.run', 42)).toBe(42);
    expect(activate).not.toHaveBeenCalled();
    expect(() => commands.registerHandler('a.run', handler)).toThrow(
      'The command a.run has a handler already',
    );
    expect(() => commands.registerHandler('a.other', handler)).toThrow(
      'No command a.other declared',
    );
  });

  it('activates the plugin of a command without its handler', async () => {
    const { commands, activate } = service();
    commands.specs.register({ id: 'a.run', title: 'Run', plugin: 'a' });
    activate.mockImplementation(async () => {
      commands.registerHandler('a.run', () => 'ran');
    });
    expect(await commands.execute('a.run')).toBe('ran');
    expect(activate).toHaveBeenCalledWith('onCommand:a.run');
  });

  it('does not run a command whose enablement does not hold', async () => {
    const { commands } = service(false);
    commands.specs.register({
      id: 'a.run',
      title: 'Run',
      enablement: 'a.on',
      plugin: 'a',
    });
    const handler = vi.fn();
    commands.registerHandler('a.run', handler);
    expect(commands.enabled('a.run')).toBe(false);
    await commands.execute('a.run');
    expect(handler).not.toHaveBeenCalled();
    expect(commands.enabled('a.none')).toBe(false);
  });
});
