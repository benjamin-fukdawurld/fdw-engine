import { describe, expect, it } from 'vitest';
import {
  activationEvents,
  editorApiVersion,
  readManifest,
  satisfiesVersion,
} from './manifest';

const minimal = { id: 'acme.tools', version: '1.0.0', engine: '^1.0.0' };

describe('satisfiesVersion', () => {
  it.each([
    ['*', '1.2.3', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['^1.2.0', '1.9.0', true],
    ['^1.2.0', '1.1.9', false],
    ['^1.2.0', '2.0.0', false],
    ['^0.2.0', '0.2.5', true],
    ['^0.2.0', '0.3.0', false],
    ['~1.2.0', '1.2.9', true],
    ['~1.2.0', '1.3.0', false],
    ['>=1.2.0', '3.0.0', true],
    ['>=1.2.0', '1.1.0', false],
    ['latest', '1.0.0', false],
  ])('%s of %s: %s', (range, version, expected) => {
    expect(satisfiesVersion(range, version)).toBe(expected);
  });
});

describe('readManifest', () => {
  it('reads a manifest and its contributions', () => {
    const manifest = {
      ...minimal,
      title: 'Acme tools',
      activationEvents: ['onStartup'],
      contributes: {
        commands: [{ id: 'acme.run', title: 'Run', icon: 'play' }],
        views: [{ id: 'acme.view', title: 'View', location: 'right' }],
        menus: {
          menubar: [{ submenu: 'acme.menu', title: 'Acme' }],
          'acme.menu': [{ command: 'acme.run', group: '1', order: 2 }],
        },
        toolbars: [
          { id: 'acme.bar', title: 'Bar', side: 'left', items: ['acme.run'] },
        ],
        statusBar: [{ id: 'acme.status', alignment: 'right', text: 'Acme' }],
        keybindings: [{ command: 'acme.run', key: 'ctrl+r' }],
        tools: [{ id: 'acme.tool', title: 'Tool', slot: 'secondary' }],
        modes: [{ id: 'acme.mode', title: 'Mode' }],
      },
    };
    expect(readManifest(manifest)).toEqual({ manifest });
  });

  it('tells what is wrong with a manifest', () => {
    const { errors } = readManifest({
      id: 'acme tools',
      version: '1',
      contributes: {
        commands: [{ id: 'acme.run' }, { id: 'acme.run', title: 'Again' }],
        views: [{ id: 'acme.view', title: 'View', location: 'top' }],
        toolbars: [{ id: 'acme.bar', title: 'Bar' }],
        tools: [{ id: 'acme.tool', title: 'Tool', slot: 'third' }],
      },
    });
    expect(errors).toEqual([
      'manifest.id is not an id',
      'manifest.version is not a version (1.0.0)',
      'manifest.engine is not a string',
      'manifest.contributes.commands[0].title is not a string',
      'manifest.contributes.commands[1]: the command acme.run twice',
      'manifest.contributes.views[0].location is not one of center, left, right, bottom',
      'manifest.contributes.toolbars[0].items is not an array',
      'manifest.contributes.tools[0].slot is not one of primary, secondary',
    ]);
    expect(readManifest('acme').errors).toEqual(['manifest is not an object']);
  });

  it('refuses a manifest written for another version of the API', () => {
    expect(readManifest({ ...minimal, engine: '^2.0.0' }).errors).toEqual([
      `manifest.engine ^2.0.0 does not accept the API ${editorApiVersion}`,
    ]);
  });
});

describe('activationEvents', () => {
  it('adds the events the contributions imply', () => {
    const { manifest } = readManifest({
      ...minimal,
      activationEvents: ['onStartup'],
      contributes: {
        commands: [{ id: 'acme.run', title: 'Run' }],
        views: [{ id: 'acme.view', title: 'View', location: 'left' }],
        tools: [{ id: 'acme.tool', title: 'Tool', slot: 'primary' }],
        modes: [{ id: 'acme.mode', title: 'Mode' }],
      },
    });
    expect(manifest && [...activationEvents(manifest)]).toEqual([
      'onStartup',
      'onView:acme.view',
      'onCommand:acme.run',
      'onTool:acme.tool',
      'onMode:acme.mode',
    ]);
  });
});
