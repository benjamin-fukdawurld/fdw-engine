import { createCube, createSphere } from '@fdw/demo-scenes';
import {
  DirectionalLight,
  Material,
  type Mesh,
  PointLight,
} from '@fdw/engine-core';
import type { Node } from '@fdw/engine-scene';
import { BuiltinTypes, GraphBuilder } from '@fdw/engine-shader';
import type { LevelPrimitive } from '../../protocol';
import { quatFromEuler } from './euler';

type Color = readonly [number, number, number];

/**
 * What the levels made in the editor are built from: two meshes, a
 * material of a color. Made once per level; written with it when saved.
 */
export class LevelParts {
  readonly cube: Mesh = createCube();
  readonly sphere: Mesh = createSphere();
  readonly #graph = (() => {
    const g = new GraphBuilder('painted');
    g.surface({
      shadingModel: 'phong',
      baseColor: g.uniform('color', BuiltinTypes.vec3f),
    });
    return g.build();
  })();

  paint(color: Color, label: string): Material {
    return new Material({
      graph: this.#graph,
      values: { color: [...color] },
      label,
    });
  }

  /** Sets up a node made by the Add menu, already named and placed. */
  build(node: Node, primitive: LevelPrimitive): void {
    switch (primitive) {
      case 'cube':
        node.setMesh(this.cube, this.paint([0.85, 0.85, 0.8], 'white'));
        break;
      case 'sphere':
        node.setMesh(this.sphere, this.paint([0.85, 0.85, 0.8], 'white'));
        break;
      case 'light':
        node.setLight(
          new PointLight({
            diffuse: { x: 1, y: 0.9, z: 0.75 },
            linearAttenuation: 0.14,
            quadraticAttenuation: 0.07,
          }),
        );
        break;
      case 'empty':
        break;
    }
  }
}

/**
 * The level of a new document: a ground, cubes, spheres, a table made of
 * five nodes, the sun. Only made of the parts: saved whole, without other
 * files.
 */
export function buildSampleLevel(root: Node, parts: LevelParts): void {
  root
    .add({
      name: 'ground',
      position: { y: -0.05 },
      scale: { x: 12, y: 0.1, z: 8 },
    })
    .setMesh(parts.cube, parts.paint([0.42, 0.44, 0.46], 'ground'));
  const cubes: [number, number, Color][] = [
    [-3, 1, [0.85, 0.35, 0.25]],
    [-1.2, -1.5, [0.3, 0.6, 0.85]],
    [3.2, 1.5, [0.9, 0.75, 0.3]],
  ];
  cubes.forEach(([x, z, color], i) =>
    root
      .add({ name: `cube ${i + 1}`, position: { x, y: 0.5, z } })
      .setMesh(parts.cube, parts.paint(color, `cube ${i + 1}`)),
  );
  const spheres: [number, number, Color][] = [
    [0.4, 1.6, [0.45, 0.8, 0.45]],
    [-3.4, -2, [0.75, 0.45, 0.85]],
  ];
  spheres.forEach(([x, z, color], i) =>
    root
      .add({
        name: `sphere ${i + 1}`,
        position: { x, y: 0.6, z },
        scale: { x: 1.2, y: 1.2, z: 1.2 },
      })
      .setMesh(parts.sphere, parts.paint(color, `sphere ${i + 1}`)),
  );
  // A group: selected whole in the viewport, its parts in the tree.
  const wood = parts.paint([0.6, 0.42, 0.28], 'wood');
  const table = root.add({ name: 'table', position: { x: 2, z: -1.6 } });
  table
    .add({ name: 'top', position: { y: 0.9 }, scale: { x: 2, y: 0.1, z: 1.2 } })
    .setMesh(parts.cube, wood);
  [
    [-0.85, -0.5],
    [0.85, -0.5],
    [-0.85, 0.5],
    [0.85, 0.5],
  ].forEach(([x, z], i) =>
    table
      .add({
        name: `leg ${i + 1}`,
        position: { x, y: 0.425, z },
        scale: { x: 0.1, y: 0.85, z: 0.1 },
      })
      .setMesh(parts.cube, wood),
  );
  // A directional light shines along the -z of its node: turned down.
  const [x, y, z, w] = quatFromEuler([-55, -30, 0]);
  root
    .add({ name: 'sun', position: { y: 6 }, rotation: { x, y, z, w } })
    .setLight(
      new DirectionalLight({
        ambient: { x: 0.25, y: 0.25, z: 0.28 },
        castShadow: true,
      }),
    );
}
