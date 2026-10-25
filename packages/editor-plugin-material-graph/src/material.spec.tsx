import { stubLayout } from '@fdw/editor-ui/testing';
import { Material } from '@fdw/engine-core';
import { itemsMaterialTarget } from '@fdw/engine-graph-editing';
import { renderGraphEditor, stubGraphDom } from '@fdw/graph-editor/testing';
import { BuiltinTypes, GraphBuilder, std } from '@fdw/engine-shader';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { materialGraphPlugin, materialGraphView } from './index';
import { acceptsMaterialType, linesOf } from './main';

beforeAll(() => {
  stubLayout();
  stubGraphDom();
});

const tinted = () => {
  const g = new GraphBuilder('tinted');
  const tint = g.uniform('tint', BuiltinTypes.vec3f, {
    slot: 'material',
    default: [1, 0.5, 0.2],
  });
  g.surface({
    shadingModel: 'unlit',
    baseColor: g.call(std.mul, { a: tint, b: 0.5 }, { label: 'half' }),
  });
  return g.build();
};

describe('the hints of the material plugin', () => {
  it('guesses the types that fit, and finds the lines of a node', () => {
    expect(acceptsMaterialType('f32', 'vec3<f32>')).toBe(true);
    expect(acceptsMaterialType('vec2<f32>', 'vec3<f32>')).toBe(false);
    expect(acceptsMaterialType('T', 'vec3<f32>')).toBe(true);
    const code = {
      language: 'wgsl',
      sources: [{ stage: 'module', code: '' }],
      lines: [{ 3: 'n1', 7: 'n2', 9: 'n1' }],
      diagnostics: [],
      time: 1,
    };
    expect(linesOf(code, 0, 'n1')).toEqual([3, 9]);
    expect(linesOf(code, 0, undefined)).toEqual([]);
  });
});

describe('the material plugin', () => {
  afterEach(cleanup);

  it('edits a material of the scene, live', async () => {
    const items = [{ material: new Material({ graph: tinted() }) }];
    const target = itemsMaterialTarget('gallery/tinted', 'Tinted', items);
    const { runtime, frame } = await renderGraphEditor(
      [materialGraphPlugin],
      [target],
    );
    await act(() => runtime.workbench.openView(materialGraphView));
    // The graph of the scene, opened by itself.
    const half = await screen.findByRole('group', { name: 'half' });
    expect(
      screen.getByRole('combobox', { name: 'Material graph shown' }),
    ).toHaveProperty('value', 'target:gallery/tinted');
    expect(screen.getByText('live')).toBeTruthy();
    // Selected, its inputs in the inspector.
    fireEvent.pointerDown(half, { button: 0 });
    fireEvent.pointerUp(window, { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Node' }));
    const field = screen.getByRole('spinbutton', { name: 'b value x' });
    fireEvent.change(field, { target: { value: '0.25' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    frame();
    await waitFor(() =>
      expect(
        items[0].material.graph.nodes.find((n) => n.label === 'half')?.defaults,
      ).toEqual({ b: [0.25, 0.5, 0.5] }),
    );
    // Undone from the bar.
    fireEvent.click(screen.getByRole('button', { name: 'Undo Edit b' }));
    frame();
    await waitFor(() =>
      expect(
        items[0].material.graph.nodes.find((n) => n.label === 'half')?.defaults,
      ).toEqual({ b: 0.5 }),
    );
    // A type that does not fit: refused, and told.
    const canvas = screen.getByRole('application');
    fireEvent.keyDown(canvas, { key: ' ' });
    const search = screen.getByRole('textbox', { name: 'Add a node' });
    fireEvent.change(search, { target: { value: 'vec4 constant' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    const constant = await screen.findByRole('group', { name: '(0, 0, 0, 0)' });
    fireEvent.pointerDown(
      within(constant).getByLabelText('(0, 0, 0, 0) output value'),
      { button: 0 },
    );
    fireEvent.pointerUp(within(half).getByLabelText('half input b'), {
      button: 0,
    });
    expect(await screen.findByText(/vec4<f32>/)).toBeTruthy();
  });

  it('makes a new graph without scene, and tells its problems', async () => {
    const { runtime } = await renderGraphEditor([materialGraphPlugin]);
    await act(() => runtime.workbench.openView(materialGraphView));
    expect(
      await screen.findByText(/The scene shows no material graph/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New material graph' }));
    expect(
      await screen.findByRole('group', { name: 'surface (pbr)' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('0 errors')).toBeTruthy();
  });
});
