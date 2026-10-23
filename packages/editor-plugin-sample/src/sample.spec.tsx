import { EditorShell, type EditorRuntime, type Layout } from '@fdw/editor-ui';
import { fakeHost, stubLayout } from '@fdw/editor-ui/testing';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { markTool, samplePlugin, sampleId } from './index';

beforeAll(stubLayout);

async function renderShell(host: ReturnType<typeof fakeHost>['host']) {
  let runtime: EditorRuntime | undefined;
  const view = render(
    <EditorShell host={host} onRuntime={(made) => (runtime = made)} />,
    { wrapper: StrictMode },
  );
  await screen.findByTestId('viewport');
  if (!runtime) throw new Error('No runtime');
  return { ...view, runtime };
}

// Chooses an item of a menu of the menu bar, by the keyboard.
function chooseInMenu(menu: string, name: string) {
  fireEvent.keyDown(screen.getByRole('menuitem', { name: menu }), {
    key: 'Enter',
  });
  const items = within(screen.getByRole('menu'));
  fireEvent.click(
    items.queryByRole('menuitem', { name }) ??
      items.getByRole('menuitemcheckbox', { name }),
  );
}

const key = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);

const primaryTool = (runtime: EditorRuntime) =>
  runtime.machine.getSnapshot().context.tools.primary;

async function storedLayout(
  stored: Map<string, unknown>,
  check: (layout: Layout) => boolean,
) {
  await waitFor(() => {
    expect(check(stored.get('layout') as Layout)).toBe(true);
  });
  return stored.get('layout') as Layout;
}

describe('the sample plugin', () => {
  afterEach(cleanup);

  it('is loaded at its first event: its tool from its toolbar', async () => {
    const { runtime } = await renderShell(fakeHost({}, [samplePlugin]).host);
    expect(runtime.plugins.info(sampleId)?.status).toBe('inactive');
    const toolbar = screen.getByRole('toolbar', { name: 'Marks' });
    expect(toolbar.parentElement?.getAttribute('data-side')).toBe('left');
    // Its commands disabled while its tool is not active.
    expect(
      within(toolbar)
        .getByRole('button', { name: 'Add a mark' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Mark' }));
    await waitFor(() => expect(primaryTool(runtime)).toBe(markTool));
    expect(runtime.plugins.info(sampleId)?.status).toBe('active');
    expect(screen.getByText('Object mode · Mark')).toBeTruthy();
  });

  it('places marks with its keys, shows them in its panel and its status', async () => {
    const { runtime } = await renderShell(fakeHost({}, [samplePlugin]).host);
    chooseInMenu('Marks', 'Mark');
    await waitFor(() => expect(primaryTool(runtime)).toBe(markTool));
    key({ key: 'm', code: 'KeyM' });
    key({ key: 'm', code: 'KeyM' });
    // Seen in the status bar while marking.
    expect(await screen.findByText(/^Marking: 2 marks \(M adds/)).toBeTruthy();
    chooseInMenu('Marks', 'Show the marks');
    expect(await screen.findByText('Marking: 2 marks.')).toBeTruthy();
    key({ key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(primaryTool(runtime)).toBeUndefined();
    expect(await screen.findByText('Marks placed: 2')).toBeTruthy();
    expect(screen.getByText('2 marks placed')).toBeTruthy();
    expect(screen.getByText('The Mark tool is not active.')).toBeTruthy();
    expect(runtime.editor.getSnapshot().context.plugins[sampleId]).toEqual({
      placed: 2,
      notes: '',
    });
  });

  it('is reloaded with its tool and its notes, and without it', async () => {
    const first = fakeHost({}, [samplePlugin]);
    const { runtime, unmount } = await renderShell(first.host);
    await runtime.commands.execute(markTool);
    await runtime.commands.execute(`${sampleId}.addMark`);
    await runtime.commands.execute(`${sampleId}.showMarks`);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Two trees' },
    });
    await storedLayout(
      first.stored,
      (saved) =>
        JSON.stringify(saved?.machine).includes(markTool) &&
        'fdw.sample.marks' in (saved?.areas.right?.panels ?? {}) &&
        JSON.stringify(saved?.plugins).includes('Two trees'),
    );
    unmount();

    // With it: its code loaded before the machine restores the tool.
    const second = fakeHost(Object.fromEntries(first.stored), [samplePlugin]);
    const restored = await renderShell(second.host);
    expect(primaryTool(restored.runtime)).toBe(markTool);
    expect(await screen.findByText('Marking: 1 mark.')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement)
        .value,
    ).toBe('Two trees');
    restored.unmount();

    // Without it: the tool idle, its panel missing, its state kept.
    const third = fakeHost(Object.fromEntries(first.stored));
    const without = await renderShell(third.host);
    expect(primaryTool(without.runtime)).toBeUndefined();
    expect(screen.getByText('Object mode')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Marks' })).toBeNull();
    expect(
      await screen.findByText(
        'No plugin gives the view fdw.sample.marks: its plugin is missing.',
      ),
    ).toBeTruthy();
    chooseInMenu('View', 'Left dock');
    const layout = await storedLayout(
      third.stored,
      (saved) => saved?.docks.left === false,
    );
    expect(layout.plugins?.[sampleId]).toEqual({
      placed: 0,
      notes: 'Two trees',
    });
  });
});
