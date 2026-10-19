import { DirectionalLight, Material, Mesh } from '@fdw/engine-core';
import type { Node, Scene } from '@fdw/engine-scene';
import { axisAngle } from '../geometry';
import { seededRandom } from '../maze/maze';
import { surfaceMaterial } from '../maze/world';

// A heterogeneous static set, for the static batching: ruins, a market and
// rocks on a square, where every object has a mesh of its own (no two
// rocks, crates or columns alike), so that instancing cannot draw them
// together.

// Positions, normals and uvs, interleaved, then the indices.
class MeshBuilder {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];

  get count(): number {
    return this.vertices.length / 8;
  }

  vertex(p: readonly number[], n: readonly number[], u: number, v: number) {
    this.vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v);
    return this.count - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  // A box from min to max, a face of 4 vertices per side.
  box(min: readonly number[], max: readonly number[]): this {
    const size = [0, 1, 2].map((axis) => max[axis] - min[axis]);
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        // Two axes u, v with u × v along the normal.
        const u = sign > 0 ? (axis + 1) % 3 : (axis + 2) % 3;
        const v = sign > 0 ? (axis + 2) % 3 : (axis + 1) % 3;
        const normal = [0, 0, 0];
        normal[axis] = sign;
        const first = this.count;
        for (const [a, b] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]) {
          const p = [0, 0, 0];
          p[axis] = sign > 0 ? max[axis] : min[axis];
          p[u] = a ? max[u] : min[u];
          p[v] = b ? max[v] : min[v];
          this.vertex(p, normal, a * size[u], b * size[v]);
        }
        this.triangle(first, first + 1, first + 2);
        this.triangle(first, first + 2, first + 3);
      }
    }
    return this;
  }

  // A surface of revolution around y: a profile of [radius, height], from
  // the bottom up, closed by flat caps.
  lathe(profile: readonly (readonly [number, number])[], segments: number) {
    const ring = segments + 1;
    const first = this.count;
    profile.forEach(([radius, y], i) => {
      // The slope of the profile there, for the normal.
      const [r0, y0] = profile[Math.max(i - 1, 0)];
      const [r1, y1] = profile[Math.min(i + 1, profile.length - 1)];
      const dr = r1 - r0;
      const dy = y1 - y0;
      const length = Math.hypot(dr, dy) || 1;
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * 2 * Math.PI;
        const x = Math.sin(angle);
        const z = Math.cos(angle);
        this.vertex(
          [x * radius, y, z * radius],
          [(x * dy) / length, -dr / length, (z * dy) / length],
          s / segments,
          y,
        );
      }
    });
    for (let i = 0; i + 1 < profile.length; i++) {
      for (let s = 0; s < segments; s++) {
        const a = first + i * ring + s;
        this.triangle(a, a + 1, a + ring);
        this.triangle(a + 1, a + ring + 1, a + ring);
      }
    }
    for (const [index, up] of [
      [0, -1],
      [profile.length - 1, 1],
    ] as const) {
      const [radius, y] = profile[index];
      const center = this.vertex([0, y, 0], [0, up, 0], 0.5, 0.5);
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * 2 * Math.PI;
        this.vertex(
          [Math.sin(angle) * radius, y, Math.cos(angle) * radius],
          [0, up, 0],
          0.5 + Math.sin(angle) / 2,
          0.5 + Math.cos(angle) / 2,
        );
      }
      for (let s = 0; s < segments; s++) {
        const a = center + 1 + s;
        if (up > 0) {
          this.triangle(center, a, a + 1);
        } else {
          this.triangle(center, a + 1, a);
        }
      }
    }
    return this;
  }

  build(label: string): Mesh {
    const wide = this.count > 0xffff;
    return new Mesh({
      label,
      description: {
        vertexBuffers: [
          {
            stride: 32,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
              { semantic: 'normal', format: 'float32x3', offset: 12 },
              { semantic: 'uv', format: 'float32x2', offset: 24 },
            ],
          },
        ],
        vertexCount: this.count,
        indexBuffer: {
          format: wide ? 'uint32' : 'uint16',
          count: this.indices.length,
        },
      },
      vertices: [new Float32Array(this.vertices)],
      indices: wide
        ? new Uint32Array(this.indices)
        : new Uint16Array(this.indices),
    });
  }
}

// A rock: a sphere pushed in and out by a few waves, flattened, with the
// normals of its faces averaged at the vertices.
function rockMesh(random: () => number, size: number): Mesh {
  const segments = 9 + Math.floor(random() * 6);
  const rings = 6 + Math.floor(random() * 4);
  const waves = Array.from({ length: 4 }, () => ({
    direction: [random() - 0.5, random() - 0.5, random() - 0.5],
    frequency: 2 + random() * 4,
    phase: random() * 6.28,
    amplitude: 0.05 + random() * 0.1,
  }));
  const flat = 0.45 + random() * 0.4;
  const points: number[][] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const theta = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const phi = (segment / segments) * 2 * Math.PI;
      const d = [
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.cos(phi),
      ];
      let radius = 1;
      for (const w of waves) {
        const along =
          d[0] * w.direction[0] + d[1] * w.direction[1] + d[2] * w.direction[2];
        radius += w.amplitude * Math.sin(along * w.frequency + w.phase);
      }
      points.push([
        d[0] * radius * size,
        d[1] * radius * size * flat,
        d[2] * radius * size,
      ]);
    }
  }
  const row = segments + 1;
  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * row + segment;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const normals = points.map(() => [0, 0, 0]);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map(
      (index) => points[index],
    );
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (let k = 0; k < 3; k++) {
      const normal = normals[indices[i + k]];
      normal[0] += n[0];
      normal[1] += n[1];
      normal[2] += n[2];
    }
  }
  // The seam and the poles share their positions: the normals too.
  const key = (p: number[]) => p.map((v) => v.toFixed(4)).join(',');
  const shared = new Map<string, number[]>();
  points.forEach((p, i) => {
    const sum = shared.get(key(p));
    if (sum) {
      sum[0] += normals[i][0];
      sum[1] += normals[i][1];
      sum[2] += normals[i][2];
    } else {
      shared.set(key(p), [...normals[i]]);
    }
  });
  const builder = new MeshBuilder();
  points.forEach((p, i) => {
    const n = shared.get(key(p)) as number[];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    builder.vertex(
      p,
      n.map((v) => v / length),
      (i % row) / segments,
      Math.floor(i / row) / rings,
    );
  });
  builder.indices.push(...indices);
  return builder.build('rock');
}

// A column on a plinth, tapered, broken at some height.
function columnMesh(random: () => number, height: number): Mesh {
  const radius = 0.38 + random() * 0.12;
  const segments = 10 + Math.floor(random() * 8);
  const taper = 0.8 + random() * 0.15;
  const profile: [number, number][] = [];
  const steps = 4 + Math.floor(height / 1.5);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    profile.push([radius * (1 - (1 - taper) * t), 0.3 + t * (height - 0.3)]);
  }
  const plinth = radius * 1.35;
  return new MeshBuilder()
    .lathe(profile, segments)
    .box([-plinth, 0, -plinth], [plinth, 0.3, plinth])
    .build('column');
}

// A barrel: a bulging lathe.
function barrelMesh(random: () => number): Mesh {
  const radius = 0.3 + random() * 0.12;
  const height = 0.8 + random() * 0.4;
  const bulge = 0.08 + random() * 0.08;
  const segments = 12 + Math.floor(random() * 8);
  const profile: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    profile.push([radius + bulge * Math.sin(t * Math.PI), t * height]);
  }
  return new MeshBuilder().lathe(profile, segments).build('barrel');
}

/** What the set is made of, once built in a scene. */
export interface Decor {
  // From the center to the edge of the square, in meters.
  readonly half: number;
  // The objects of the set: their nodes, all static.
  readonly objects: readonly Node[];
  readonly materials: readonly Material[];
  readonly sun: DirectionalLight;
}

export interface DecorOptions {
  // The side of the square, in meters. Default 160.
  readonly size?: number;
  readonly seed?: number;
}

/**
 * Builds the set in a scene: a ground, ruins of temples (columns, some
 * broken, and their fallen drums), low walls of stones, the crates and
 * barrels of a market, and rocks; about 1 500 objects, each with its own
 * mesh, in five materials. Every object is a static node, named after
 * what it is.
 */
export function buildDecor(scene: Scene, options: DecorOptions = {}): Decor {
  const size = options.size ?? 160;
  const half = size / 2;
  const random = seededRandom(options.seed ?? 12);
  const stone = surfaceMaterial([0.72, 0.68, 0.6], 0.8);
  const rock = surfaceMaterial([0.42, 0.4, 0.38], 0.9);
  const wood = surfaceMaterial([0.5, 0.34, 0.2], 0.75);
  const barrel = surfaceMaterial([0.38, 0.22, 0.12], 0.6);
  const wall = surfaceMaterial([0.6, 0.52, 0.44], 0.85);
  const materials = [stone, rock, wood, barrel, wall];
  const objects: Node[] = [];
  const turn = (angle: number) => axisAngle(0, 1, 0, angle);
  const place = (
    name: string,
    mesh: Mesh,
    material: Material,
    x: number,
    z: number,
    { y = 0, angle = random() * 6.28 }: { y?: number; angle?: number } = {},
  ) => {
    const node = scene.root
      .add({ name, position: { x, y, z }, rotation: turn(angle), static: true })
      .setMesh(mesh, material);
    objects.push(node);
    return node;
  };
  const inside = (x: number, z: number) =>
    Math.abs(x) < half - 2 && Math.abs(z) < half - 2;

  scene.root
    .add({ name: 'ground', static: true })
    .setMesh(
      new MeshBuilder()
        .box([-half, -0.5, -half], [half, 0, half])
        .build('ground'),
      surfaceMaterial([0.36, 0.34, 0.28], 0.95),
      { castShadow: false },
    );

  // Temples: two rows of columns, some broken, their drums around.
  for (let t = 0; t < 9; t++) {
    const cx = (t % 3) * 50 - 50 + (random() - 0.5) * 10;
    const cz = Math.floor(t / 3) * 50 - 50 + (random() - 0.5) * 10;
    const angle = random() * 6.28;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 7; i++) {
        const lx = (i - 3) * 3.2;
        const lz = side * 4;
        const broken = random() < 0.35;
        const height = broken ? 1 + random() * 3 : 6 + random() * 0.5;
        place(
          'column',
          columnMesh(random, height),
          stone,
          cx + lx * cos + lz * sin,
          cz - lx * sin + lz * cos,
          { angle },
        );
        if (broken) {
          // The fallen drums, on their side.
          for (let d = 0; d < 2; d++) {
            const node = place(
              'drum',
              columnMesh(random, 0.6 + random() * 0.6),
              stone,
              cx + lx * cos + lz * sin + (random() - 0.5) * 5,
              cz - lx * sin + lz * cos + (random() - 0.5) * 5,
              { y: 0.4 },
            );
            node.transform.rotation = axisAngle(
              random() - 0.5,
              0,
              random() - 0.5,
              Math.PI / 2,
            );
          }
        }
      }
    }
  }

  // Low walls of stones of all sizes.
  for (let w = 0; w < 24; w++) {
    let x = (random() - 0.5) * (size - 20);
    let z = (random() - 0.5) * (size - 20);
    const angle = random() * 6.28;
    for (let i = 0; i < 14 && inside(x, z); i++) {
      const length = 0.6 + random() * 0.8;
      const depth = 0.5 + random() * 0.3;
      // Two courses, the second on the first.
      let y = 0;
      for (let course = 0; course < 2; course++) {
        const height = 0.35 + random() * 0.4;
        place(
          'stone',
          new MeshBuilder()
            .box([-length / 2, 0, -depth / 2], [length / 2, height, depth / 2])
            .build('stone'),
          wall,
          x,
          z,
          { y, angle: angle + (random() - 0.5) * 0.1 },
        );
        y += height;
      }
      x += Math.cos(angle) * (length + 0.05);
      z -= Math.sin(angle) * (length + 0.05);
    }
  }

  // The market: piles of crates and barrels.
  for (let m = 0; m < 40; m++) {
    const cx = (random() - 0.5) * (size - 20);
    const cz = (random() - 0.5) * (size - 20);
    for (let i = 0; i < 8; i++) {
      const x = cx + (random() - 0.5) * 6;
      const z = cz + (random() - 0.5) * 6;
      if (random() < 0.6) {
        const s = 0.5 + random() * 0.6;
        const w = s * (0.8 + random() * 0.6);
        place(
          'crate',
          new MeshBuilder()
            .box([-w / 2, 0, -s / 2], [w / 2, s, s / 2])
            .build('crate'),
          wood,
          x,
          z,
        );
      } else {
        place('barrel', barrelMesh(random), barrel, x, z);
      }
    }
  }

  // Rocks everywhere.
  for (let r = 0; r < 420; r++) {
    const x = (random() - 0.5) * (size - 6);
    const z = (random() - 0.5) * (size - 6);
    const s = 0.3 + random() ** 3 * 2.2;
    place('rock', rockMesh(random, s), rock, x, z, { y: -s * 0.15 });
  }

  const sun = new DirectionalLight({
    castShadow: true,
    ambient: { x: 0.3, y: 0.32, z: 0.38 },
    diffuse: { x: 1.5, y: 1.4, z: 1.2 },
    specular: { x: 1, y: 0.95, z: 0.85 },
  });
  scene.root
    .add({ name: 'sun', rotation: axisAngle(0.914, 0.406, 0, -0.55) })
    .setLight(sun);
  return { half, objects, materials, sun };
}
