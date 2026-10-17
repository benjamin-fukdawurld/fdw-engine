// Writes the models of the forest of the TPS demo (P8) into
// apps/docs/public/models/forest/, from the Poly Haven models (CC0):
// fir_tree_01, fern_02, grass_medium_01 and the textures of
// forest_ground_04 (https://polyhaven.com). The sources are not in the
// repository: download them (glTF, 1k) into one directory.
//
// - fir.glb: the three firs, each a node `fir_<v>` with its levels of
//   detail `fir_<v>_LOD0..2` (tens of thousands of triangles down to a few
//   thousand, instead of 0.5 to 4.2 million). The needles become textured
//   cards (see foliage.mjs), the trunk and the branches are simplified.
// - fern.glb, grass.glb: one node per plant, simplified.
// - forest_ground_*.jpg: the textures of the ground.
//
// The needles, the fronds and the blades are geometry, their textures
// have no alpha: the materials are made opaque (Poly Haven marks them
// BLEND or MASK), double-sided. The vertex colors (all white) are left out.
//
// Usage: node tools/assets/make-forest.mjs [--from <directory>] [--only fir]
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  addMesh,
  addNode,
  documentWithMaterials,
  primitivesOf,
  readGltf,
  writeGlb,
} from './gltf.mjs';
import sharp from 'sharp';
import { cards } from './foliage.mjs';
import { simplify, triangleCount } from './mesh.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    from: { type: 'string', default: root },
    out: {
      type: 'string',
      default: join(root, 'apps/docs/public/models/forest'),
    },
    only: { type: 'string' },
  },
});
mkdirSync(values.out, { recursive: true });
const source = (name) =>
  join(values.from, `${name}_1k.gltf`, `${name}_1k.gltf`);
const attributes = ['POSITION', 'NORMAL', 'TEXCOORD_0'];

// What the engine does not read, and the opacity of geometry foliage.
function cleanMaterials(doc) {
  for (const material of doc.json.materials) {
    delete material.extensions?.KHR_materials_specular;
    delete material.extensions?.KHR_materials_ior;
    if (material.extensions && !Object.keys(material.extensions).length) {
      delete material.extensions;
    }
    delete material.alphaMode;
    delete material.alphaCutoff;
    material.doubleSided = true;
  }
  doc.json.extensionsUsed = doc.json.extensionsUsed?.filter(
    (name) => name === 'KHR_texture_transform',
  );
  if (!doc.json.extensionsUsed?.length) delete doc.json.extensionsUsed;
}

// Cylindrical texture coordinates around the vertical axis, for the
// primitives without any (the trunk of the third fir): u around, v up.
function withUvs(primitive) {
  if (primitive.attributes.TEXCOORD_0) return primitive;
  const positions = primitive.attributes.POSITION;
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let v = 0; v < positions.length / 3; v++) {
    const [x, y, z] = positions.subarray(v * 3, v * 3 + 3);
    uvs[v * 2] = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    uvs[v * 2 + 1] = y / 2;
  }
  return {
    ...primitive,
    attributes: { ...primitive.attributes, TEXCOORD_0: uvs },
  };
}

const log = (name, primitives) =>
  console.log(
    `${name}: ${primitives.reduce((sum, p) => sum + triangleCount(p), 0)} triangles`,
  );

// The levels: the size of the cells of the needle cards (meters), and the
// budgets of the trunk and the branches in triangles (0: left out).
const Needles = 'fir_tree_01_twig';
const FirLevels = [
  { cell: 0.3, trunk: 12000, branches: 8000, dead: 3000 },
  { cell: 0.6, trunk: 2500, branches: 1500, dead: 0 },
  { cell: 1.2, trunk: 400, branches: 0, dead: 0 },
];

// An image of the document from RGBA pixels, as PNG; returns its index.
async function addImage(doc, { pixels, width, height }) {
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  doc.json.images.push({});
  doc.images.push({ bytes, mimeType: 'image/png' });
  return doc.json.images.length - 1;
}

async function decode(doc, texture) {
  const image = doc.images[doc.json.textures[texture].source];
  const { data, info } = await sharp(image.bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function makeFir() {
  const doc = readGltf(source('fir_tree_01'));
  const out = documentWithMaterials(doc);
  cleanMaterials(out);
  const materials = doc.json.materials.map((m) => m.name);
  const needles = materials.indexOf(Needles);
  const diffuse = await decode(
    doc,
    doc.json.materials[needles].pbrMetallicRoughness.baseColorTexture.index,
  );
  for (const [n, node] of doc.json.nodes.entries()) {
    const variant = String.fromCharCode(97 + n);
    const group = addNode(out, { name: `fir_${variant}` });
    const primitives = primitivesOf(doc, node.mesh, attributes).map(withUvs);
    for (const [level, budget] of FirLevels.entries()) {
      const kept = [];
      for (const primitive of primitives) {
        const name = materials[primitive.material];
        if (name === Needles) {
          const { primitive: card, image } = cards(primitive, diffuse, {
            size: budget.cell,
            seed: level,
          });
          // A material per level: its texture is baked from its cells.
          out.json.textures.push({
            source: await addImage(out, image),
            sampler: 0,
          });
          out.json.materials.push({
            name: `fir_${variant}_needles_LOD${level}`,
            alphaMode: 'MASK',
            alphaCutoff: 0.5,
            doubleSided: true,
            pbrMetallicRoughness: {
              baseColorTexture: { index: out.json.textures.length - 1 },
              metallicFactor: 0,
              roughnessFactor: 0.85,
            },
          });
          kept.push({ ...card, material: out.json.materials.length - 1 });
          continue;
        }
        const target = name.includes('trunk')
          ? budget.trunk
          : name.includes('dead')
            ? budget.dead
            : budget.branches;
        if (target > 0)
          kept.push(simplify(primitive, target, { maxError: 0.2 }));
      }
      const name = `fir_${variant}_LOD${level}`;
      log(name, kept);
      addNode(out, { name, mesh: addMesh(out, name, kept) }, group);
    }
  }
  writeGlb(out, join(values.out, 'fir.glb'));
}

// One node per plant, simplified to `ratio` of its triangles.
function makePlants(name, file, ratio) {
  const doc = readGltf(source(file));
  const out = documentWithMaterials(doc);
  cleanMaterials(out);
  doc.json.nodes.forEach((node, n) => {
    if (node.mesh === undefined) return;
    const primitives = primitivesOf(doc, node.mesh, attributes).map((p) =>
      simplify(p, Math.max(16, Math.round(triangleCount(p) * ratio)), {
        maxError: 0.05,
      }),
    );
    const plant = `${name}_${n}`;
    log(plant, primitives);
    addNode(out, { name: plant, mesh: addMesh(out, plant, primitives) });
  });
  writeGlb(out, join(values.out, `${name}.glb`));
}

function copyGround() {
  for (const map of ['diff', 'nor_gl', 'rough']) {
    copyFileSync(
      join(
        values.from,
        'forest_ground_04_1k.gltf/textures',
        `forest_ground_04_${map}_1k.jpg`,
      ),
      join(values.out, `forest_ground_${map}.jpg`),
    );
  }
}

const jobs = {
  fir: makeFir,
  fern: () => makePlants('fern', 'fern_02', 0.5),
  grass: () => makePlants('grass', 'grass_medium_01', 0.35),
  ground: copyGround,
};
for (const [name, job] of Object.entries(jobs)) {
  if (!values.only || values.only.split(',').includes(name)) await job();
}
