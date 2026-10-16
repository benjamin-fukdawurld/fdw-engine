import { describe, expect, it } from 'vitest';
import { colorGraph } from '../testing/fakeBackend';
import { Material } from './Material';

describe('Material', () => {
  it('makes a variant on another graph, with its values, features and state', () => {
    const material = new Material({
      graph: colorGraph(),
      values: { color: [0, 1, 0], roughness: 0.5 },
      features: { normalMap: true },
      renderState: { alphaMode: 'mask', doubleSided: true },
      label: 'grass',
    });
    const variant = material.withGraph(colorGraph('skinned'), {
      joints: 3,
    });
    expect(variant.graph.name).toBe('skinned');
    expect(variant.getValue('color')).toEqual([0, 1, 0]);
    expect(variant.getValue('joints')).toBe(3);
    expect(variant.getValue('alphaCutoff')).toBe(0.5);
    expect(variant.features).toEqual({ normalMap: true });
    expect(variant.renderState).toEqual(material.renderState);
    expect(variant.label).toBe('grass');
    // Apart from then on.
    variant.setValue('color', [1, 1, 1]);
    expect(material.getValue('color')).toEqual([0, 1, 0]);
  });
});
