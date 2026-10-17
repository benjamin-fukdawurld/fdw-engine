// Writes the characters of the TPS demo (P8) into
// apps/docs/public/models/forest/, from CC0 models:
//
// - hero.glb: the ranger of Quaternius' Modular Character Outfits - Fantasy
//   (Male_Ranger), the antique estoc of Poly Haven in its right hand (a node
//   under the joint hand_r), and the clips it plays, copied from
//   Quaternius' Universal Animation Library 1 and 2 (the same skeleton). Its
//   4096 px textures are scaled down to 1024 px (512 px for the skin: only
//   the hands show), in JPEG.
// - orc.glb, demon.glb: Orc and Demon of Quaternius' Ultimate Monsters
//   (Big), with their own clips.
//
// The sources are not in the repository (https://quaternius.com,
// https://polyhaven.com): put their directories, as downloaded, into one.
//
// Usage: node tools/assets/make-characters.mjs [--from <directory>]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import {
  addNode,
  importAnimation,
  importMesh,
  readGltf,
  writeGlb,
} from './gltf.mjs';

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
const from = (...path) => join(values.from, ...path);

// The clips of the hero: [library, name in the library, name in hero.glb].
const HeroClips = [
  ['UAL1', 'Idle_Loop', 'Idle'],
  ['UAL1', 'Walk_Loop', 'Walk'],
  ['UAL1', 'Jog_Fwd_Loop', 'Jog'],
  ['UAL1', 'Sprint_Loop', 'Sprint'],
  ['UAL1', 'Jump_Start', 'JumpStart'],
  ['UAL1', 'Jump_Loop', 'JumpLoop'],
  ['UAL1', 'Jump_Land', 'JumpLand'],
  ['UAL1', 'Roll', 'Roll'],
  ['UAL1', 'Hit_Chest', 'Hit'],
  ['UAL1', 'Death01', 'Death'],
  ['UAL1', 'Sword_Idle', 'SwordIdle'],
  ['UAL1', 'Sword_Attack', 'HeavyAttack'],
  ['UAL2', 'Sword_Regular_A', 'AttackA'],
  ['UAL2', 'Sword_Regular_A_Rec', 'AttackARecover'],
  ['UAL2', 'Sword_Regular_B', 'AttackB'],
  ['UAL2', 'Sword_Regular_B_Rec', 'AttackBRecover'],
  ['UAL2', 'Sword_Regular_C', 'AttackC'],
  ['UAL2', 'Sword_Block', 'Block'],
];

// The estoc: its blade along -z, its guard along x, the middle of its
// grip at z = 0.1 (meters, before the scale).
const Sword = {
  blade: [0, 0, -1],
  guard: [1, 0, 0],
  grip: [0, 0, 0.1],
  scale: 0.8,
};

// Matrices (column-major 4 × 4) and quaternions, for the grip.
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    }
  }
  return out;
};
const compose = (
  [tx, ty, tz] = [0, 0, 0],
  [x, y, z, w] = [0, 0, 0, 1],
  [sx, sy, sz] = [1, 1, 1],
) => [
  (1 - 2 * (y * y + z * z)) * sx,
  2 * (x * y + z * w) * sx,
  2 * (x * z - y * w) * sx,
  0,
  2 * (x * y - z * w) * sy,
  (1 - 2 * (x * x + z * z)) * sy,
  2 * (y * z + x * w) * sy,
  0,
  2 * (x * z + y * w) * sz,
  2 * (y * z - x * w) * sz,
  (1 - 2 * (x * x + y * y)) * sz,
  0,
  tx,
  ty,
  tz,
  1,
];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const normalize = (v) => v.map((c) => c / Math.hypot(...v));
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// The quaternion of a rotation matrix given by its columns.
function quaternionOf([X, Y, Z]) {
  const trace = X[0] + Y[1] + Z[2];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(Y[2] - Z[1]) * s, (Z[0] - X[2]) * s, (X[1] - Y[0]) * s, 0.25 / s];
  }
  if (X[0] > Y[1] && X[0] > Z[2]) {
    const s = 2 * Math.sqrt(1 + X[0] - Y[1] - Z[2]);
    return [0.25 * s, (Y[0] + X[1]) / s, (Z[0] + X[2]) / s, (Y[2] - Z[1]) / s];
  }
  if (Y[1] > Z[2]) {
    const s = 2 * Math.sqrt(1 + Y[1] - X[0] - Z[2]);
    return [(Y[0] + X[1]) / s, 0.25 * s, (Z[1] + Y[2]) / s, (Z[0] - X[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + Z[2] - X[0] - Y[1]);
  return [(Z[0] + X[2]) / s, (Z[1] + Y[2]) / s, 0.25 * s, (X[1] - Y[0]) / s];
}

/**
 * Where the sword sits in the frame of the joint hand_r, from the pose of
 * the hand in `clip` at `time` (a clip that grips it): the grip through the
 * middle phalanges, the blade out of the thumb side (from the little finger
 * to the index), the guard along the fingers.
 */
function gripOf(hero, library, clip, time) {
  const nodes = hero.json.nodes;
  const index = new Map(nodes.map((node, i) => [node.name, i]));
  const parents = new Map();
  nodes.forEach((node, i) =>
    node.children?.forEach((child) => parents.set(child, i)),
  );
  // The local transforms, posed by the keys of the clip at `time`.
  const local = nodes.map((node) => ({
    t: node.translation,
    r: node.rotation,
    s: node.scale,
  }));
  const animation = library.json.animations.find((a) => a.name === clip);
  for (const channel of animation.channels) {
    const target = index.get(library.json.nodes[channel.target.node].name);
    if (target === undefined || channel.target.path === 'weights') continue;
    const sampler = animation.samplers[channel.sampler];
    const times = library.data[sampler.input];
    let key = 0;
    while (key + 1 < times.length && times[key + 1] <= time) key++;
    const size = channel.target.path === 'rotation' ? 4 : 3;
    const value = [
      ...library.data[sampler.output].slice(key * size, key * size + size),
    ];
    local[target][
      { translation: 't', rotation: 'r', scale: 's' }[channel.target.path]
    ] = value;
  }
  const world = (i) => {
    const m = compose(local[i].t, local[i].r, local[i].s);
    return parents.has(i) ? multiply(world(parents.get(i)), m) : m;
  };
  const hand = world(index.get('hand_r'));
  // Points of the hand in its own frame (its matrix inverted: rigid, with
  // a uniform scale).
  const scale = Math.hypot(hand[0], hand[1], hand[2]);
  const toHand = (p) => {
    const d = sub(p, [hand[12], hand[13], hand[14]]);
    return [0, 1, 2].map(
      (c) =>
        dot(d, [hand[c * 4], hand[c * 4 + 1], hand[c * 4 + 2]]) /
        (scale * scale),
    );
  };
  const at = (name) => {
    const m = world(index.get(name));
    return toHand([m[12], m[13], m[14]]);
  };
  const phalanges = [
    'index_02_r',
    'middle_02_r',
    'ring_02_r',
    'pinky_02_r',
  ].map(at);
  const grip = [0, 1, 2].map(
    (c) => phalanges.reduce((sum, p) => sum + p[c], 0) / 4,
  );
  const blade = normalize(sub(at('index_01_r'), at('pinky_01_r')));
  const fingers = normalize(sub(at('middle_01_r'), [0, 0, 0]));
  // An orthonormal frame: the blade, the guard (along the fingers), their
  // normal; the sword axes mapped onto it.
  const guard = normalize(
    sub(
      fingers,
      blade.map((c) => c * dot(fingers, blade)),
    ),
  );
  const third = cross(guard, blade);
  // Columns of the rotation: where the sword's x, y and z axes go. Its
  // blade is -z and its guard x: z = -blade, x = guard, y = z × x.
  const z = blade.map((c) => -c);
  const x = guard;
  const y = cross(z, x);
  void third;
  const rotation = quaternionOf([x, y, z]);
  // The middle of the sword's grip on the grip of the hand.
  const offset = [0, 1, 2].map(
    (c) =>
      x[c] * Sword.grip[0] * Sword.scale +
      y[c] * Sword.grip[1] * Sword.scale +
      z[c] * Sword.grip[2] * Sword.scale,
  );
  return {
    translation: sub(grip, offset),
    rotation,
    scale: [Sword.scale, Sword.scale, Sword.scale],
  };
}

// The images of a document resized and re-encoded in JPEG: `size` gives
// the size (pixels) for the name of each image.
async function shrinkImages(doc, size) {
  for (const [i, image] of doc.json.images.entries()) {
    const name = image.name ?? image.uri ?? `image ${i}`;
    const pixels = size(name);
    const bytes = await sharp(doc.images[i].bytes)
      .resize(pixels, pixels)
      .removeAlpha()
      .jpeg({ quality: 88 })
      .toBuffer();
    doc.images[i] = { bytes, mimeType: 'image/jpeg' };
    image.name = String(name).replace(/\.png$/, '');
    delete image.uri;
  }
}

async function makeHero() {
  const outfits =
    'Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits';
  const hero = readGltf(from(outfits, 'Male_Ranger.gltf'));
  await shrinkImages(hero, (name) => (name.includes('Regular') ? 512 : 1024));

  const libraries = {
    UAL1: readGltf(
      from(
        'Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb',
      ),
    ),
    UAL2: readGltf(
      from(
        'Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb',
      ),
    ),
  };

  const estoc = readGltf(
    from('antique_estoc_1k.gltf', 'antique_estoc_1k.gltf'),
  );
  const hand = hero.json.nodes.findIndex((node) => node.name === 'hand_r');
  const grip = gripOf(hero, libraries.UAL1, 'Sword_Idle', 0.5);
  console.log('hero: sword in hand_r', JSON.stringify(grip));
  addNode(
    hero,
    { name: 'Sword', mesh: importMesh(hero, estoc, 0), ...grip },
    hand,
  );
  for (const [library, name, rename] of HeroClips) {
    const channels = importAnimation(hero, libraries[library], name, rename);
    console.log(`hero: ${rename} (${library} ${name}), ${channels} channels`);
  }
  writeGlb(hero, join(values.out, 'hero.glb'));
}

function makeMonster(name) {
  const monster = readGltf(
    from(
      'Ultimate Monsters-20261017T182059Z-1-001/Ultimate Monsters/Big/glTF',
      `${name}.gltf`,
    ),
  );
  console.log(
    `${name}: ${monster.json.animations.map((a) => a.name).join(', ')}`,
  );
  writeGlb(monster, join(values.out, `${name.toLowerCase()}.glb`));
}

const jobs = {
  hero: makeHero,
  orc: () => makeMonster('Orc'),
  demon: () => makeMonster('Demon'),
};
for (const [name, job] of Object.entries(jobs)) {
  if (!values.only || values.only.split(',').includes(name)) await job();
}
