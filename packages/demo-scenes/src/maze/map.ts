import type { GpuTexture, RenderBackend, Surface } from '@fdw/engine-backend';
import {
  Material,
  Renderer,
  RenderGraph,
  TextureHandle,
} from '@fdw/engine-core';
import { BuiltinTypes, std } from '@fdw/engine-shader';
import type { Exploration } from './exploration';
import { Inset, insetGraph, insetRect } from './inset';
import { Wall } from './maze';

// Pixels per cell in the picture of the map: a wall line, then the floor.
const pixelsPerCell = 4;

// The colors of the map: rgba bytes, as one little-endian 32-bit word.
const rgba = (r: number, g: number, b: number) =>
  (255 << 24) | (b << 16) | (g << 8) | r;
const fog = rgba(10, 11, 15);
const floor = rgba(70, 64, 56);
const wall = rgba(205, 200, 215);
const marker = [1, 0.45, 0.1];

/** A cell drawn in a color of its own on the map: a gem, the exit. */
export interface MapMark {
  readonly cell: number;
  readonly color: readonly [number, number, number];
}

/**
 * The map of the maze, in a corner of the screen: only what the player has
 * discovered, the rest in the fog. A picture drawn on the CPU, a few pixels
 * per cell, written into a texture when the exploration changes; a
 * fullscreen pass shows it, with the player on top.
 */
export class MazeMap implements Inset {
  // The picture, a word per pixel: its bytes are uploaded.
  private readonly _pixels: Uint32Array;
  private readonly _bytes: Uint8Array<ArrayBuffer>;
  private readonly _texture: GpuTexture;
  private readonly _material: Material;
  private readonly _size: number;
  private _version = -1;
  // Cells drawn in a color of their own, once discovered.
  private _marks: readonly MapMark[] = [];
  private _marksKey = '';
  private _drawnMarks = '';

  constructor(
    private readonly _backend: RenderBackend,
    private readonly _renderer: Renderer,
    private readonly _exploration: Exploration,
  ) {
    const { maze } = _exploration.level;
    // A line of pixels for each wall, cells between them.
    this._size = Math.max(maze.width, maze.height) * pixelsPerCell + 1;
    const buffer = new ArrayBuffer(this._size * this._size * 4);
    this._pixels = new Uint32Array(buffer);
    this._bytes = new Uint8Array(buffer);
    this._texture = _backend.textures.createTexture({
      label: 'maze map',
      type: '2d',
      // Colors: decoded to linear values as they are sampled.
      format: 'rgba8unorm-srgb',
      dimensions: { width: this._size, height: this._size },
    });
    this._material = new Material({
      graph: insetGraph('maze map', (g, local) => {
        // The part of the picture shown: x, y, then its size, in uv.
        const window = g.uniform('window', BuiltinTypes.vec4f);
        const uv = g.call(std.add, {
          a: window.swizzle('xy'),
          b: g.call(std.mul, { a: local, b: window.swizzle('zw') }),
        });
        const color = g
          .call(std.textureSample, {
            texture: g.texture('map'),
            sampler: g.sampler('mapSampler'),
            uv,
          })
          .swizzle('rgb');
        // The player: a dot, and a smaller one ahead, where it faces.
        const player = g.uniform('player', BuiltinTypes.vec2f);
        const ahead = g.uniform('ahead', BuiltinTypes.vec2f);
        // The radius in cells of the picture: the same size on the inset
        // whatever the zoom.
        const dot = (center: typeof player, radius: number) =>
          g.call(std.sub, {
            a: 1,
            b: g.call(std.smoothstep, {
              low: radius * 0.6,
              high: radius,
              x: g.call(std.div, {
                a: g.call(std.length, {
                  x: g.call(std.sub, { a: uv, b: center }),
                }),
                b: window.swizzle('z'),
              }),
            }),
          });
        const shown = g.call(std.max, {
          a: dot(player, 0.018),
          b: dot(ahead, 0.01),
        });
        // color × (1 − shown) + marker × shown.
        return g.call(std.add, {
          a: g.call(std.mul, {
            a: color,
            b: g.call(std.sub, { a: 1, b: shown }),
          }),
          b: g.call(std.mul, {
            a: g.constant(BuiltinTypes.vec3f, marker),
            b: shown,
          }),
        });
      }),
      values: {
        map: this._texture,
        mapSampler: _backend.textures.createSampler({
          wrapModeS: 'clamp-to-edge',
          wrapModeT: 'clamp-to-edge',
          minFilter: 'linear',
          magFilter: 'linear',
          mipmapFilter: 'nearest',
        }),
      },
    });
  }

  /**
   * The number of cells across the inset, around the player; the whole
   * maze when undefined.
   */
  zoom: number | undefined = 16;

  /**
   * Places the player on the map: where it is, and where it faces. With a
   * zoom, the map follows it.
   */
  setPlayer(position: { x: number; z: number }, heading: number): void {
    const u = this.uvOf(position.x, position.z);
    const { maze } = this._exploration.level;
    const cells = Math.max(maze.width, maze.height);
    // The size of the window, in uv; its corner, within the picture.
    const size = this.zoom === undefined ? 1 : Math.min(1, this.zoom / cells);
    const corner = (c: number) => Math.min(1 - size, Math.max(0, c - size / 2));
    this._material.setValue('window', [corner(u[0]), corner(u[1]), size, size]);
    // Its nose: 0.6 cells ahead, towards -z when the heading is 0.
    const cell = this._exploration.level.cellSize * 0.6;
    const v = this.uvOf(
      position.x - Math.sin(heading) * cell,
      position.z - Math.cos(heading) * cell,
    );
    this._material.setValue('player', u);
    this._material.setValue('ahead', v);
  }

  /** The marks of the map: shown on the cells discovered. */
  setMarks(marks: readonly MapMark[]): void {
    this._marks = marks;
    this._marksKey = marks
      .map(({ cell, color }) => `${cell}:${color.join(',')}`)
      .join(' ');
  }

  add(
    graph: RenderGraph,
    target: TextureHandle,
    surface: Surface,
  ): TextureHandle {
    if (
      this._version !== this._exploration.version ||
      this._drawnMarks !== this._marksKey
    ) {
      this.draw();
      this._drawnMarks = this._marksKey;
      this._backend.textures.writeTexture(this._texture, this._bytes);
      this._version = this._exploration.version;
    }
    this._material.setValue('rect', insetRect(surface).rect);
    return this._renderer.addFullscreenPass(graph, 'maze map', {
      material: this._material,
      target,
      format: surface.format,
      load: 'load',
      blend: true,
    });
  }

  destroy(): void {
    this._texture.destroy();
  }

  // Where a point of the world is on the picture, in uv.
  private uvOf(x: number, z: number): [number, number] {
    const { cellSize, halfWidth, halfDepth } = this._exploration.level;
    // In cells from the corner, then in pixels: wall lines at multiples of
    // pixelsPerCell, the centers of pixels at + 0.5.
    const px = ((x + halfWidth) / cellSize) * pixelsPerCell + 0.5;
    const pz = ((z + halfDepth) / cellSize) * pixelsPerCell + 0.5;
    return [px / this._size, pz / this._size];
  }

  // The picture: fog, then the floor and the walls of the discovered cells.
  private draw(): void {
    const pixels = this._pixels;
    const size = this._size;
    pixels.fill(fog);
    const fill = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      color: number,
    ) => {
      for (let z = z0; z <= z1; z++) {
        pixels.fill(color, z * size + x0, z * size + x1 + 1);
      }
    };
    const { maze } = this._exploration.level;
    const { discovered } = this._exploration;
    const n = pixelsPerCell;
    for (let pass = 0; pass < 2; pass++) {
      for (let z = 0; z < maze.height; z++) {
        for (let x = 0; x < maze.width; x++) {
          const cell = z * maze.width + x;
          if (!discovered[cell]) {
            continue;
          }
          const x0 = x * n;
          const z0 = z * n;
          if (pass === 0) {
            fill(x0, z0, x0 + n, z0 + n, floor);
            continue;
          }
          // The walls over the floors, those of the neighbors included.
          const walls = maze.cells[cell];
          if (walls & Wall.North) {
            fill(x0, z0, x0 + n, z0, wall);
          }
          if (walls & Wall.South) {
            fill(x0, z0 + n, x0 + n, z0 + n, wall);
          }
          if (walls & Wall.West) {
            fill(x0, z0, x0, z0 + n, wall);
          }
          if (walls & Wall.East) {
            fill(x0 + n, z0, x0 + n, z0 + n, wall);
          }
        }
      }
    }
    // The marks, inside their cells.
    for (const { cell, color } of this._marks) {
      if (discovered[cell]) {
        const x0 = (cell % maze.width) * n;
        const z0 = Math.floor(cell / maze.width) * n;
        fill(x0 + 1, z0 + 1, x0 + n - 1, z0 + n - 1, rgba(...color));
      }
    }
  }
}
