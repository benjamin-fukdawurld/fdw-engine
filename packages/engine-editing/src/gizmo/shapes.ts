import { Mesh } from '@fdw/engine-core';

// The meshes of the gizmos, in the space of the gizmo: its axes are 1 long.
// Each shape is made along x (or around it), then its coordinates rotated
// to the axis it belongs to.

/** One of the three axes: 0 x, 1 y, 2 z. */
export type Axis = 0 | 1 | 2;

type Point = readonly [number, number, number];

// Rotates x to the axis: (x, y, z) to (z, x, y) for y, (y, z, x) for z.
const toAxis = ([x, y, z]: Point, axis: Axis): Point =>
  axis === 0 ? [x, y, z] : axis === 1 ? [z, x, y] : [y, z, x];

/** Positions and normals, and triangles, gathered into one mesh. */
export class ShapeBuilder {
  private readonly _vertices: number[] = [];
  private readonly _indices: number[] = [];

  constructor(private readonly _axis: Axis = 0) {}

  private vertex(position: Point, normal: Point): number {
    this._vertices.push(
      ...toAxis(position, this._axis),
      ...toAxis(normal, this._axis),
    );
    return this._vertices.length / 6 - 1;
  }

  /** A tube along x from `from` to `to`, its radius going from r0 to r1 (0: a cone). */
  tube(from: number, to: number, r0: number, r1: number, segments = 16): this {
    const slope = (r0 - r1) / (to - from);
    const first = this._vertices.length / 6;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const l = Math.hypot(1, slope);
      const normal: Point = [slope / l, c / l, s / l];
      this.vertex([from, c * r0, s * r0], normal);
      this.vertex([to, c * r1, s * r1], normal);
    }
    for (let i = 0; i < segments; i++) {
      const a = first + i * 2;
      this._indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    // The caps.
    for (const [x, r, n] of [
      [from, r0, -1],
      [to, r1, 1],
    ] as const) {
      if (r > 0) {
        const center = this.vertex([x, 0, 0], [n, 0, 0]);
        for (let i = 0; i <= segments; i++) {
          const a = (i / segments) * Math.PI * 2;
          this.vertex([x, Math.cos(a) * r, Math.sin(a) * r], [n, 0, 0]);
        }
        for (let i = 0; i < segments; i++) {
          this._indices.push(center, center + 1 + i, center + 2 + i);
        }
      }
    }
    return this;
  }

  /** A box centered on (x, 0, 0) along x, of half size `half`. */
  box(x: number, half: number): this {
    for (let face = 0; face < 6; face++) {
      const axis = face >> 1;
      const sign = face & 1 ? -1 : 1;
      const normal = [0, 0, 0];
      normal[axis] = sign;
      const u = [0, 0, 0];
      u[(axis + 1) % 3] = 1;
      const v = [0, 0, 0];
      v[(axis + 2) % 3] = 1;
      const first = this._vertices.length / 6;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        this.vertex(
          [
            x + (normal[0] + u[0] * a + v[0] * b) * half,
            (normal[1] + u[1] * a + v[1] * b) * half,
            (normal[2] + u[2] * a + v[2] * b) * half,
          ],
          normal as unknown as Point,
        );
      }
      this._indices.push(
        first,
        first + 1,
        first + 2,
        first,
        first + 2,
        first + 3,
      );
    }
    return this;
  }

  /** A ring around x, in the plane yz: a torus of radius `radius`, its tube `thickness`. */
  ring(radius: number, thickness: number, segments = 64, sides = 8): this {
    const first = this._vertices.length / 6;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (let j = 0; j <= sides; j++) {
        const b = (j / sides) * Math.PI * 2;
        const normal: Point = [Math.sin(b), Math.cos(b) * c, Math.cos(b) * s];
        this.vertex(
          [
            normal[0] * thickness,
            c * radius + normal[1] * thickness,
            s * radius + normal[2] * thickness,
          ],
          normal,
        );
      }
    }
    const row = sides + 1;
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < sides; j++) {
        const a = first + i * row + j;
        this._indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    return this;
  }

  /** A square in the plane yz, from `from` to `to` on both axes. */
  square(from: number, to: number): this {
    const first = this._vertices.length / 6;
    for (const [y, z] of [
      [from, from],
      [to, from],
      [to, to],
      [from, to],
    ]) {
      this.vertex([0, y, z], [1, 0, 0]);
    }
    this._indices.push(
      first,
      first + 1,
      first + 2,
      first,
      first + 2,
      first + 3,
    );
    return this;
  }

  /** A sphere at the origin. */
  sphere(radius: number, segments = 16, rings = 8): this {
    const first = this._vertices.length / 6;
    for (let ring = 0; ring <= rings; ring++) {
      const theta = (ring / rings) * Math.PI;
      for (let segment = 0; segment <= segments; segment++) {
        const phi = (segment / segments) * Math.PI * 2;
        const normal: Point = [
          Math.cos(theta),
          Math.sin(theta) * Math.cos(phi),
          Math.sin(theta) * Math.sin(phi),
        ];
        this.vertex(
          [normal[0] * radius, normal[1] * radius, normal[2] * radius],
          normal,
        );
      }
    }
    const row = segments + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let segment = 0; segment < segments; segment++) {
        const a = first + ring * row + segment;
        this._indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    return this;
  }

  /** The mesh of the shapes added. */
  build(label: string): Mesh {
    const count = this._vertices.length / 6;
    const indices =
      count > 0xffff
        ? new Uint32Array(this._indices)
        : new Uint16Array(this._indices);
    return new Mesh({
      label,
      description: {
        vertexBuffers: [
          {
            stride: 24,
            stepMode: 'vertex',
            attributes: [
              { semantic: 'position', format: 'float32x3', offset: 0 },
              { semantic: 'normal', format: 'float32x3', offset: 12 },
            ],
          },
        ],
        vertexCount: count,
        indexBuffer: {
          format: count > 0xffff ? 'uint32' : 'uint16',
          count: indices.length,
        },
      },
      vertices: [new Float32Array(this._vertices)],
      indices,
    });
  }
}
