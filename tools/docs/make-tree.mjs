// Writes apps/docs/public/models/tree.glb, the tree of the tutorial
// "Loading models": a trunk and two crowns, three nodes, two metallic /
// roughness materials, the crowns sharing one mesh. Generated, so that the
// documentation ships no third-party model.
// Usage: node tools/docs/make-tree.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(
  new URL('../../apps/docs/public/models/tree.glb', import.meta.url)
);

// A cone (or a cylinder with top > 0) around y, from y0 to y1, with smooth
// normals on the side and a cap at the bottom.
function cone({ segments, radius, top, y0, y1 }) {
  const positions = [];
  const normals = [];
  const indices = [];
  const slope = (radius - top) / (y1 - y0);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const n = Math.hypot(1, slope);
    positions.push(c * radius, y0, s * radius, c * top, y1, s * top);
    normals.push(c / n, slope / n, s / n, c / n, slope / n, s / n);
  }
  for (let i = 0; i < segments; i++) {
    const [a, b, c, d] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3];
    indices.push(a, b, c, c, b, d);
  }
  // The bottom cap.
  const center = positions.length / 3;
  positions.push(0, y0, 0);
  normals.push(0, -1, 0);
  const ring = center + 1;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(a) * radius, y0, Math.sin(a) * radius);
    normals.push(0, -1, 0);
  }
  for (let i = 0; i < segments; i++)
    indices.push(center, ring + i, ring + i + 1);
  return { positions, normals, indices };
}

const meshes = [
  cone({ segments: 12, radius: 0.12, top: 0.08, y0: 0, y1: 0.9 }),
  cone({ segments: 16, radius: 0.55, top: 0, y0: 0, y1: 0.9 }),
];

// The binary chunk: per mesh, positions, normals, indices (4-byte aligned).
const chunks = [];
const bufferViews = [];
const accessors = [];
let offset = 0;
const push = (array, target, extra) => {
  const bytes = Buffer.from(array.buffer);
  bufferViews.push({
    buffer: 0,
    byteOffset: offset,
    byteLength: bytes.length,
    target,
  });
  accessors.push({ bufferView: bufferViews.length - 1, ...extra });
  chunks.push(bytes);
  offset += bytes.length;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  return accessors.length - 1;
};
const gltfMeshes = meshes.map((m, i) => {
  const p = new Float32Array(m.positions);
  const min = [0, 1, 2].map((k) =>
    Math.min(...m.positions.filter((_, j) => j % 3 === k))
  );
  const max = [0, 1, 2].map((k) =>
    Math.max(...m.positions.filter((_, j) => j % 3 === k))
  );
  const position = push(p, 34962, {
    componentType: 5126,
    count: p.length / 3,
    type: 'VEC3',
    min,
    max,
  });
  const normal = push(new Float32Array(m.normals), 34962, {
    componentType: 5126,
    count: p.length / 3,
    type: 'VEC3',
  });
  const indices = push(new Uint16Array(m.indices), 34963, {
    componentType: 5123,
    count: m.indices.length,
    type: 'SCALAR',
  });
  return {
    name: i === 0 ? 'Trunk' : 'Crown',
    primitives: [
      {
        attributes: { POSITION: position, NORMAL: normal },
        indices,
        material: i,
      },
    ],
  };
});
const bin = Buffer.concat(chunks);

const json = {
  asset: { version: '2.0', generator: 'fdw-engine tools/docs/make-tree.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'Tree', mesh: 0, children: [1, 2] },
    { name: 'Lower crown', mesh: 1, translation: [0, 0.6, 0] },
    {
      name: 'Upper crown',
      mesh: 1,
      translation: [0, 1.05, 0],
      scale: [0.7, 0.8, 0.7],
    },
  ],
  meshes: gltfMeshes,
  materials: [
    {
      name: 'Bark',
      pbrMetallicRoughness: {
        baseColorFactor: [0.3, 0.17, 0.08, 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
    },
    {
      name: 'Leaves',
      pbrMetallicRoughness: {
        baseColorFactor: [0.12, 0.42, 0.12, 1],
        metallicFactor: 0,
        roughnessFactor: 0.7,
      },
    },
  ],
  buffers: [{ byteLength: bin.length }],
  bufferViews,
  accessors,
};

// The GLB container: header, JSON chunk (space padded), BIN chunk.
let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
const total = 12 + 8 + text.length + 8 + bin.length;
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(total, 8);
const chunkHeader = (length, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
writeFileSync(
  out,
  Buffer.concat([
    header,
    chunkHeader(text.length, 0x4e4f534a),
    text,
    chunkHeader(bin.length, 0x004e4942),
    bin,
  ])
);
console.log(`${out}: ${total} bytes`);
