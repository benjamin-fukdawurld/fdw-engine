// Foliage made of geometry (a fir has 800 000 needles of 5 triangles)
// turned into textured cards, the technique of real-time foliage: the
// needles are grouped in the cells of a grid, each cell becomes a quad in
// the plane of its needles (their principal axes), and the needles of a
// typical cell are rasterized into a texture with alpha, which every card
// shows. Larger cells, fewer cards: the levels of detail.
import { islands } from './mesh.mjs';

// The eigenvectors of a symmetric 3 × 3 matrix (Jacobi rotations), sorted
// by decreasing eigenvalue: the principal axes of a cloud of points.
function principalAxes(m) {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t =
        Math.sign(theta || 1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2]
    .map((i) => ({ value: a[i][i], axis: [v[0][i], v[1][i], v[2][i]] }))
    .sort((x, y) => y.value - x.value)
    .map(({ axis }) => axis);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The cells of the grid and the vertices of their islands.
function cellsOf(primitive, size, offset) {
  const { of } = islands(primitive);
  const positions = primitive.attributes.POSITION;
  const { indices } = primitive;
  // The first vertex of each island places it: islands are small.
  const cells = new Map();
  const cellOfIsland = new Map();
  for (let t = 0; t < of.length; t++) {
    let key = cellOfIsland.get(of[t]);
    if (key === undefined) {
      const v = indices[t * 3];
      key = [0, 1, 2]
        .map((c) => Math.floor((positions[v * 3 + c] + offset[c]) / size))
        .join(',');
      cellOfIsland.set(of[t], key);
    }
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { triangles: [], islands: new Set() }));
    cell.triangles.push(t);
    cell.islands.add(of[t]);
  }
  return [...cells.values()];
}

// The frame of a cell: its center, principal axes and extents along them.
function frameOf(primitive, cell) {
  const positions = primitive.attributes.POSITION;
  const { indices } = primitive;
  const points = [];
  for (const t of cell.triangles) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      points.push([
        positions[v * 3],
        positions[v * 3 + 1],
        positions[v * 3 + 2],
      ]);
    }
  }
  const center = [0, 1, 2].map(
    (c) => points.reduce((sum, p) => sum + p[c], 0) / points.length,
  );
  const m = [0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const d = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
    m[0] += d[0] * d[0];
    m[1] += d[0] * d[1];
    m[2] += d[0] * d[2];
    m[3] += d[1] * d[1];
    m[4] += d[1] * d[2];
    m[5] += d[2] * d[2];
  }
  const axes = principalAxes(m);
  const extent = axes.slice(0, 2).map((axis) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      const d = dot(
        [p[0] - center[0], p[1] - center[1], p[2] - center[2]],
        axis,
      );
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    return [min, max];
  });
  return { center, axes, extent };
}

/**
 * Rasterizes the triangles of a cell, seen along its smallest axis, into
 * an RGBA image of `width` × `height`: the color sampled from `diffuse`
 * (`{ pixels, width, height, channels }`) at their texture coordinates,
 * alpha 1 where they cover. The transparent pixels take the color of the
 * nearest covered ones (dilated), so that filtering does not darken the
 * edges.
 */
function bake(primitive, cell, frame, diffuse, width, height) {
  const positions = primitive.attributes.POSITION;
  const uvs = primitive.attributes.TEXCOORD_0;
  const { indices } = primitive;
  const color = new Float32Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  const [[min0, max0], [min1, max1]] = frame.extent;
  const project = (v) => {
    const d = [0, 1, 2].map((c) => positions[v * 3 + c] - frame.center[c]);
    return [
      ((dot(d, frame.axes[0]) - min0) / (max0 - min0)) * width,
      ((max1 - dot(d, frame.axes[1])) / (max1 - min1)) * height,
    ];
  };
  const sample = (u, v) => {
    const x = Math.min(
      diffuse.width - 1,
      Math.max(0, Math.floor((u - Math.floor(u)) * diffuse.width)),
    );
    const y = Math.min(
      diffuse.height - 1,
      Math.max(0, Math.floor((v - Math.floor(v)) * diffuse.height)),
    );
    const o = (y * diffuse.width + x) * diffuse.channels;
    return [diffuse.pixels[o], diffuse.pixels[o + 1], diffuse.pixels[o + 2]];
  };
  for (const t of cell.triangles) {
    const vs = [0, 1, 2].map((k) => indices[t * 3 + k]);
    const [a, b, c] = vs.map(project);
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 =
          ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 =
          ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        // A little wider than the triangle: needles are thinner than a
        // texel of the card.
        if (w0 < -0.15 || w1 < -0.15 || w2 < -0.15) continue;
        const u =
          w0 * uvs[vs[0] * 2] + w1 * uvs[vs[1] * 2] + w2 * uvs[vs[2] * 2];
        const v =
          w0 * uvs[vs[0] * 2 + 1] +
          w1 * uvs[vs[1] * 2 + 1] +
          w2 * uvs[vs[2] * 2 + 1];
        const rgb = sample(u, v);
        const p = y * width + x;
        color[p * 3] = rgb[0];
        color[p * 3 + 1] = rgb[1];
        color[p * 3 + 2] = rgb[2];
        alpha[p] = 255;
      }
    }
  }
  // Dilation: each pass gives the empty pixels the mean of their covered
  // neighbors.
  const filled = Uint8Array.from(alpha, (a) => (a ? 1 : 0));
  for (let pass = 0; pass < 16; pass++) {
    const next = filled.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (filled[p]) continue;
        let n = 0;
        const sum = [0, 0, 0];
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const qx = x + dx;
          const qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
          const q = qy * width + qx;
          if (!filled[q]) continue;
          n++;
          for (let c = 0; c < 3; c++) sum[c] += color[q * 3 + c];
        }
        if (n) {
          for (let c = 0; c < 3; c++) color[p * 3 + c] = sum[c] / n;
          next[p] = 1;
        }
      }
    }
    filled.set(next);
  }
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    out[p * 4] = color[p * 3];
    out[p * 4 + 1] = color[p * 3 + 1];
    out[p * 4 + 2] = color[p * 3 + 2];
    out[p * 4 + 3] = alpha[p];
  }
  return out;
}

/**
 * The cards of `primitive` (geometry foliage with texture coordinates on
 * `diffuse`) for cells of `size` meters, and the texture they show:
 * `{ primitive, image: { pixels, width, height } }`. The normals lean away
 * from the vertical axis through `axis` (the trunk), by `outward`: a crown
 * lit as a volume rather than as flat cards.
 */
export function cards(
  primitive,
  diffuse,
  {
    size,
    width = 256,
    height = 256,
    minTriangles = 20,
    axis = [0, 0],
    outward = 0.6,
    grow = 1.25,
    seed = 0,
  },
) {
  const offset = [seed * 0.37 * size, seed * 0.61 * size, seed * 0.23 * size];
  const cells = cellsOf(primitive, size, offset).filter(
    (cell) => cell.triangles.length >= minTriangles,
  );
  const frames = cells.map((cell) => frameOf(primitive, cell));

  // The typical cell: one of the densest, whose needles cover most of
  // the texture.
  const order = cells
    .map((cell, i) => [cell.triangles.length, i])
    .sort((a, b) => a[0] - b[0]);
  const typical = order[Math.floor(order.length * 0.9)][1];
  const pixels = bake(
    primitive,
    cells[typical],
    frames[typical],
    diffuse,
    width,
    height,
  );

  const positions = new Float32Array(cells.length * 4 * 3);
  const normals = new Float32Array(cells.length * 4 * 3);
  const uvs = new Float32Array(cells.length * 4 * 2);
  const indices = new Uint32Array(cells.length * 6);
  frames.forEach(({ center, axes, extent }, i) => {
    const corners = [
      [extent[0][0], extent[1][1], 0, 0],
      [extent[0][1], extent[1][1], 1, 0],
      [extent[0][1], extent[1][0], 1, 1],
      [extent[0][0], extent[1][0], 0, 1],
    ];
    // The normal of the card, turned outwards, leaned away from the trunk.
    let n = axes[2];
    const away = [center[0] - axis[0], 0.35, center[2] - axis[1]];
    const length = Math.hypot(...away) || 1;
    if (dot(n, away) < 0) n = n.map((c) => -c);
    const leaned = n.map(
      (c, k) => c * (1 - outward) + (away[k] / length) * outward,
    );
    const ln = Math.hypot(...leaned) || 1;
    // The cards grown a little around their middle: they cover the gaps
    // the texture of one cell leaves.
    const middle = [0, 1].map((a) => (extent[a][0] + extent[a][1]) / 2);
    corners.forEach(([s, t, u, v], k) => {
      const o = i * 4 + k;
      const gs = middle[0] + (s - middle[0]) * grow;
      const gt = middle[1] + (t - middle[1]) * grow;
      for (let c = 0; c < 3; c++) {
        positions[o * 3 + c] = center[c] + axes[0][c] * gs + axes[1][c] * gt;
        normals[o * 3 + c] = leaned[c] / ln;
      }
      uvs[o * 2] = u;
      uvs[o * 2 + 1] = v;
    });
    indices.set(
      [i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3],
      i * 6,
    );
  });
  return {
    primitive: {
      attributes: { POSITION: positions, NORMAL: normals, TEXCOORD_0: uvs },
      indices,
      material: primitive.material,
    },
    image: { pixels, width, height },
  };
}
