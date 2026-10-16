// Writes apps/docs/public/models/character.glb, the character of the
// tutorial "An animated character": a body of tubes and spheres skinned to
// a skeleton of 18 joints, its clothes in vertex colors, and five clips:
// Idle, Walk, Run, Jump and Wave. Generated, so that the documentation
// ships no third-party model.
// Usage: node tools/docs/make-character.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(
  new URL('../../apps/docs/public/models/character.glb', import.meta.url),
);

// --- The skeleton -------------------------------------------------------------
// Y up, facing +Z: the left of the character is +X. Positions relative to
// the parent, in meters; no rotation at rest.
const joints = [
  ['root', -1, [0, 0, 0]],
  ['hips', 'root', [0, 0.95, 0]],
  ['spine', 'hips', [0, 0.14, 0]],
  ['chest', 'spine', [0, 0.22, 0]],
  ['neck', 'chest', [0, 0.24, 0]],
  ['head', 'neck', [0, 0.09, 0]],
  ['upperArm.L', 'chest', [0.2, 0.18, 0]],
  ['lowerArm.L', 'upperArm.L', [0, -0.28, 0]],
  ['hand.L', 'lowerArm.L', [0, -0.25, 0]],
  ['upperArm.R', 'chest', [-0.2, 0.18, 0]],
  ['lowerArm.R', 'upperArm.R', [0, -0.28, 0]],
  ['hand.R', 'lowerArm.R', [0, -0.25, 0]],
  ['upperLeg.L', 'hips', [0.1, -0.06, 0]],
  ['lowerLeg.L', 'upperLeg.L', [0, -0.42, 0]],
  ['foot.L', 'lowerLeg.L', [0, -0.41, 0]],
  ['upperLeg.R', 'hips', [-0.1, -0.06, 0]],
  ['lowerLeg.R', 'upperLeg.R', [0, -0.42, 0]],
  ['foot.R', 'lowerLeg.R', [0, -0.41, 0]],
];
const jointIndex = new Map(joints.map(([name], i) => [name, i]));
const parentOf = joints.map(([, parent]) =>
  parent === -1 ? -1 : jointIndex.get(parent),
);
// Model space positions at rest.
const bind = [];
joints.forEach(([, , t], i) => {
  const p = parentOf[i] < 0 ? [0, 0, 0] : bind[parentOf[i]];
  bind.push([p[0] + t[0], p[1] + t[1], p[2] + t[2]]);
});
const at = (name) => bind[jointIndex.get(name)];

// --- The body -----------------------------------------------------------------
const positions = [];
const normals = [];
const colors = [];
const jointIds = [];
const weights = [];
const indices = [];

const skin = [0.94, 0.72, 0.56, 1];
const shirt = [0.18, 0.42, 0.78, 1];
const pants = [0.16, 0.17, 0.26, 1];
const shoes = [0.3, 0.17, 0.1, 1];
const hair = [0.25, 0.14, 0.08, 1];

function vertex(p, n, color, influences) {
  positions.push(...p);
  normals.push(...n);
  colors.push(...color);
  const sorted = [...influences, [0, 0], [0, 0], [0, 0]].slice(0, 4);
  jointIds.push(...sorted.map(([j]) => j));
  weights.push(...sorted.map(([, w]) => w));
  return positions.length / 3 - 1;
}

// A tube along a chain of joints, from `from` to `to` (model space, along
// the bones), its rings weighted between the joints of the chain around
// them: the elbows and the knees bend smoothly. `radius(t)` and
// `color(t)` along it, t from 0 to 1.
function tube({ chain, from, to, radius, color, rings = 12, segments = 12 }) {
  const ids = chain.map((name) => jointIndex.get(name));
  const heights = chain.map((name) => at(name));
  const axis = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...axis);
  const dir = axis.map((v) => v / length);
  // A frame around the axis.
  const side = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(side, dir));
  const v = cross(dir, u);
  // The weight of the joints at a point, by its place along the chain:
  // the bone of its segment, blended with the next (or the previous) one
  // over a fifth of the segment around each joint.
  const along = (q) =>
    (q[0] - from[0]) * dir[0] +
    (q[1] - from[1]) * dir[1] +
    (q[2] - from[2]) * dir[2];
  const stops = heights.map(along);
  const influence = (p) => {
    const s = along(p);
    const last = ids.length - 1;
    if (s >= stops[last]) return [[ids[last], 1]];
    let i = 0;
    while (i < last - 1 && s > stops[i + 1]) i++;
    const t = Math.min(
      Math.max((s - stops[i]) / (stops[i + 1] - stops[i]), 0),
      1,
    );
    if (t > 0.8) {
      const w = (t - 0.8) / 0.4;
      return [
        [ids[i], 1 - w],
        [ids[i + 1], w],
      ];
    }
    if (t < 0.2 && i > 0) {
      const w = (0.2 - t) / 0.4;
      return [
        [ids[i], 1 - w],
        [ids[i - 1], w],
      ];
    }
    return [[ids[i], 1]];
  };
  const first = positions.length / 3;
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const center = from.map((c, k) => c + axis[k] * t);
    const rad = radius(t);
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const n = [0, 1, 2].map((k) => Math.cos(a) * u[k] + Math.sin(a) * v[k]);
      const p = center.map((c, k) => c + n[k] * rad);
      vertex(p, n, color(t), influence(center));
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = first + r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  // The caps.
  for (const [end, t, sign] of [
    [from, 0, -1],
    [to, 1, 1],
  ]) {
    const n = dir.map((d) => d * sign);
    const center = vertex(end, n, color(t), influence(end));
    const ring = positions.length / 3;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const o = [0, 1, 2].map((k) => Math.cos(a) * u[k] + Math.sin(a) * v[k]);
      vertex(
        end.map((c, k) => c + o[k] * radius(t)),
        n,
        color(t),
        influence(end),
      );
    }
    for (let s = 0; s < segments; s++) {
      if (sign > 0) indices.push(center, ring + s, ring + s + 1);
      else indices.push(center, ring + s + 1, ring + s);
    }
  }
}

// A sphere, on one joint.
function sphere({ center, radius, joint, color, scale = [1, 1, 1] }) {
  const id = jointIndex.get(joint);
  const first = positions.length / 3;
  const rows = 12;
  const columns = 16;
  for (let i = 0; i <= rows; i++) {
    const phi = (i / rows) * Math.PI;
    for (let j = 0; j <= columns; j++) {
      const theta = (j / columns) * Math.PI * 2;
      const n = [
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.cos(theta),
      ];
      const p = n.map((c, k) => center[k] + c * radius * scale[k]);
      vertex(p, normalize(n.map((c, k) => c / scale[k])), color(n), [[id, 1]]);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      const a = first + i * (columns + 1) + j;
      const b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

// A box, on one joint.
function box({ min, max, joint, color }) {
  const id = jointIndex.get(joint);
  const faces = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const n of faces) {
    const axis = n.findIndex((c) => c !== 0);
    const [a, b] = [0, 1, 2].filter((k) => k !== axis);
    const value = n[axis] > 0 ? max[axis] : min[axis];
    const corners = [
      [min[a], min[b]],
      [max[a], min[b]],
      [max[a], max[b]],
      [min[a], max[b]],
    ];
    const first = positions.length / 3;
    for (const [ca, cb] of corners) {
      const p = [0, 0, 0];
      p[axis] = value;
      p[a] = ca;
      p[b] = cb;
      vertex(p, n, color, [[id, 1]]);
    }
    // Counter-clockwise seen from outside: the corners turn around a × b,
    // which is -y for the faces along y.
    const flip = (axis === 1 ? -1 : 1) * n[axis] < 0;
    if (flip)
      indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
    else indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
}

// The torso: from below the hips to the neck, the shirt over the belt.
const hips = at('hips');
tube({
  chain: ['hips', 'spine', 'chest', 'neck'],
  from: [0, hips[1] - 0.1, 0],
  to: [0, at('neck')[1] + 0.02, 0],
  radius: (t) => 0.15 + 0.04 * Math.sin(Math.min(t * 1.3, 1) * Math.PI * 0.9),
  color: (t) => (t < 0.18 ? pants : shirt),
  rings: 16,
});
// The neck and the head, with hair and a nose to see where it looks.
tube({
  chain: ['neck', 'head'],
  from: at('neck'),
  to: [0, at('head')[1] + 0.02, 0],
  radius: () => 0.05,
  color: () => skin,
  rings: 3,
});
const head = at('head');
sphere({
  center: [0, head[1] + 0.11, 0],
  radius: 0.12,
  joint: 'head',
  scale: [0.9, 1.05, 1],
  color: (n) => (n[1] > 0.35 || (n[2] < -0.2 && n[1] > -0.4) ? hair : skin),
});
box({
  min: [-0.015, head[1] + 0.07, 0.1],
  max: [0.015, head[1] + 0.11, 0.135],
  joint: 'head',
  color: skin,
});
for (const side of ['L', 'R']) {
  // The arms: the sleeves, then the skin.
  const shoulder = at(`upperArm.${side}`);
  const hand = at(`hand.${side}`);
  tube({
    chain: [`upperArm.${side}`, `lowerArm.${side}`, `hand.${side}`],
    from: [shoulder[0], shoulder[1] + 0.03, 0],
    to: hand,
    radius: (t) => 0.055 - 0.02 * t,
    color: (t) => (t < 0.35 ? shirt : skin),
  });
  sphere({
    center: [hand[0], hand[1] - 0.06, 0],
    radius: 0.05,
    joint: `hand.${side}`,
    scale: [0.7, 1.2, 0.9],
    color: () => skin,
  });
  // The legs, then the shoes.
  const hip = at(`upperLeg.${side}`);
  const ankle = at(`foot.${side}`);
  tube({
    chain: [`upperLeg.${side}`, `lowerLeg.${side}`, `foot.${side}`],
    from: [hip[0], hip[1] + 0.05, 0],
    to: ankle,
    radius: (t) => 0.085 - 0.035 * t,
    color: () => pants,
  });
  box({
    min: [ankle[0] - 0.055, 0, -0.06],
    max: [ankle[0] + 0.055, 0.08, 0.17],
    joint: `foot.${side}`,
    color: shoes,
  });
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function normalize(a) {
  const l = Math.hypot(...a);
  return a.map((c) => c / l);
}

// --- The clips ----------------------------------------------------------------
const fps = 30;
const quatX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const quatY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const quatZ = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const mulQ = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

// A clip sampled at 30 frames a second from functions of the time: the
// rotation of joints, and the translation of the hips.
function clip(name, duration, { rotations, hips: hipsAt }) {
  const frames = Math.round(duration * fps);
  const times = Array.from({ length: frames + 1 }, (_, i) => i / fps);
  const channels = Object.entries(rotations).map(([joint, f]) => ({
    joint,
    path: 'rotation',
    values: times.flatMap((t) => f(t)),
  }));
  if (hipsAt) {
    channels.push({
      joint: 'hips',
      path: 'translation',
      values: times.flatMap((t) => hipsAt(t)),
    });
  }
  return { name, times, channels };
}

const tau = Math.PI * 2;
const hipsRest = joints[jointIndex.get('hips')][2];

function locomotion(name, period, a) {
  const phase = (t) => (t / period) * tau;
  const knee = (p) => a.knee0 + a.knee * Math.max(0, Math.sin(p - 0.9));
  return clip(name, period, {
    hips: (t) => [0, hipsRest[1] - a.drop + a.bob * Math.cos(2 * phase(t)), 0],
    rotations: {
      hips: (t) => quatY(a.twist * Math.sin(phase(t))),
      spine: (t) => quatX(a.lean),
      chest: (t) => quatY(-a.twist * 1.4 * Math.sin(phase(t))),
      neck: () => quatX(-a.lean * 0.6),
      'upperLeg.L': (t) => quatX(-a.leg * Math.sin(phase(t)) - a.lift),
      'upperLeg.R': (t) => quatX(a.leg * Math.sin(phase(t)) - a.lift),
      'lowerLeg.L': (t) => quatX(knee(phase(t) + Math.PI)),
      'lowerLeg.R': (t) => quatX(knee(phase(t))),
      'foot.L': (t) => quatX(-0.25 * Math.sin(phase(t)) - 0.05),
      'foot.R': (t) => quatX(0.25 * Math.sin(phase(t)) - 0.05),
      'upperArm.L': (t) => mulQ(quatZ(0.12), quatX(a.arm * Math.sin(phase(t)))),
      'upperArm.R': (t) =>
        mulQ(quatZ(-0.12), quatX(-a.arm * Math.sin(phase(t)))),
      'lowerArm.L': (t) => quatX(-a.elbow - 0.2 * a.arm * Math.sin(phase(t))),
      'lowerArm.R': (t) => quatX(-a.elbow + 0.2 * a.arm * Math.sin(phase(t))),
    },
  });
}

const clips = [
  // Breathing, the arms hanging, the head looking around.
  clip('Idle', 3, {
    hips: (t) => [0, hipsRest[1] + 0.005 * Math.cos((t / 3) * 2 * tau), 0],
    rotations: {
      chest: (t) => quatX(-0.02 + 0.02 * Math.sin((t / 3) * 2 * tau)),
      head: (t) => quatY(0.25 * Math.sin((t / 3) * tau)),
      'upperArm.L': (t) => quatZ(0.1 + 0.02 * Math.sin((t / 3) * 2 * tau)),
      'upperArm.R': (t) => quatZ(-0.1 - 0.02 * Math.sin((t / 3) * 2 * tau)),
      'lowerArm.L': () => quatX(-0.15),
      'lowerArm.R': () => quatX(-0.15),
    },
  }),
  locomotion('Walk', 1.1, {
    leg: 0.45,
    knee0: 0.08,
    knee: 0.75,
    lift: 0,
    arm: 0.4,
    elbow: 0.25,
    bob: 0.02,
    drop: 0.01,
    twist: 0.08,
    lean: 0.04,
  }),
  locomotion('Run', 0.66, {
    leg: 0.8,
    knee0: 0.3,
    knee: 1.4,
    lift: 0.25,
    arm: 0.75,
    elbow: 1.2,
    bob: 0.045,
    drop: 0.07,
    twist: 0.12,
    lean: 0.22,
  }),
  // A crouch, the take off, the legs tucked, the landing.
  clip('Jump', 1, {
    hips: (t) => {
      const crouch = t < 0.25 ? Math.sin((t / 0.25) * Math.PI) * 0.15 : 0;
      const air =
        t >= 0.2 && t < 0.8 ? Math.sin(((t - 0.2) / 0.6) * Math.PI) * 0.45 : 0;
      const land =
        t >= 0.78 ? Math.sin(((t - 0.78) / 0.22) * Math.PI) * 0.1 : 0;
      return [0, hipsRest[1] - crouch + air - land, 0];
    },
    rotations: Object.fromEntries(
      [
        ['upperLeg.L', -1],
        ['upperLeg.R', -1],
        ['lowerLeg.L', 2],
        ['lowerLeg.R', 2],
        ['foot.L', -0.6],
        ['foot.R', -0.6],
      ]
        .map(([joint, k]) => [
          joint,
          (t) => {
            const tuck =
              t < 0.25
                ? Math.sin((t / 0.25) * Math.PI) * 0.35
                : t < 0.8
                  ? Math.sin(((t - 0.25) / 0.55) * Math.PI) * 0.6
                  : Math.sin(((t - 0.8) / 0.2) * Math.PI) * 0.25;
            return quatX(k * tuck);
          },
        ])
        .concat([
          [
            'upperArm.L',
            (t) =>
              mulQ(
                quatZ(
                  0.3 + 1.6 * Math.sin(Math.min(t / 0.6, 1) * Math.PI) ** 2,
                ),
                quatX(0),
              ),
          ],
          [
            'upperArm.R',
            (t) =>
              mulQ(
                quatZ(
                  -0.3 - 1.6 * Math.sin(Math.min(t / 0.6, 1) * Math.PI) ** 2,
                ),
                quatX(0),
              ),
          ],
          [
            'spine',
            (t) => quatX(0.25 * Math.sin(Math.min(t / 0.3, 1) * Math.PI)),
          ],
        ]),
    ),
  }),
  // The right arm up, the hand waving: a layer for the upper body.
  clip('Wave', 1.2, {
    rotations: {
      'upperArm.R': (t) => {
        const up = Math.min(t / 0.25, 1, (1.2 - t) / 0.25);
        return mulQ(quatZ(-2.5 * up), quatX(-0.2 * up));
      },
      'lowerArm.R': (t) => {
        const up = Math.min(t / 0.25, 1, (1.2 - t) / 0.25);
        return quatZ(up * (-0.4 + 0.45 * Math.sin((t / 1.2) * 3 * tau)));
      },
      'hand.R': () => quatX(0),
      head: (t) => quatY(-0.3 * Math.min(t / 0.25, 1, (1.2 - t) / 0.25)),
    },
  }),
];

// --- The file -----------------------------------------------------------------
const chunks = [];
const bufferViews = [];
const accessors = [];
let offset = 0;
const push = (array, extra, target) => {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  bufferViews.push({
    buffer: 0,
    byteOffset: offset,
    byteLength: bytes.length,
    ...(target ? { target } : {}),
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
const vertexCount = positions.length / 3;
const bounds = (k) => positions.filter((_, i) => i % 3 === k);
const attributes = {
  POSITION: push(
    new Float32Array(positions),
    {
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3',
      min: [0, 1, 2].map((k) => Math.min(...bounds(k))),
      max: [0, 1, 2].map((k) => Math.max(...bounds(k))),
    },
    34962,
  ),
  NORMAL: push(
    new Float32Array(normals),
    { componentType: 5126, count: vertexCount, type: 'VEC3' },
    34962,
  ),
  COLOR_0: push(
    new Float32Array(colors),
    { componentType: 5126, count: vertexCount, type: 'VEC4' },
    34962,
  ),
  JOINTS_0: push(
    new Uint8Array(jointIds),
    { componentType: 5121, count: vertexCount, type: 'VEC4' },
    34962,
  ),
  WEIGHTS_0: push(
    new Float32Array(weights),
    { componentType: 5126, count: vertexCount, type: 'VEC4' },
    34962,
  ),
};
const indexAccessor = push(
  new Uint16Array(indices),
  { componentType: 5123, count: indices.length, type: 'SCALAR' },
  34963,
);
// The inverse bind matrices: the joints have no rotation at rest.
const inverseBinds = push(
  new Float32Array(
    bind.flatMap(([x, y, z]) => [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      -x,
      -y,
      -z,
      1,
    ]),
  ),
  { componentType: 5126, count: joints.length, type: 'MAT4' },
);

// Nodes: 0 the character, 1 its body (the mesh), then the joints.
const firstJoint = 2;
const nodes = [
  { name: 'Character', children: [1, firstJoint] },
  { name: 'Body', mesh: 0, skin: 0 },
  ...joints.map(([name, , translation], i) => ({
    name,
    ...(i > 0 ? { translation } : {}),
    children: joints
      .map((_, j) => j)
      .filter((j) => parentOf[j] === i)
      .map((j) => firstJoint + j),
  })),
];
for (const node of nodes) {
  if (node.children?.length === 0) delete node.children;
}

const animations = clips.map(({ name, times, channels }) => {
  const input = push(new Float32Array(times), {
    componentType: 5126,
    count: times.length,
    type: 'SCALAR',
    min: [times[0]],
    max: [times[times.length - 1]],
  });
  const samplers = [];
  const gltfChannels = channels.map(({ joint, path, values }) => {
    samplers.push({
      input,
      output: push(new Float32Array(values), {
        componentType: 5126,
        count: times.length,
        type: path === 'rotation' ? 'VEC4' : 'VEC3',
      }),
      interpolation: 'LINEAR',
    });
    return {
      sampler: samplers.length - 1,
      target: { node: firstJoint + jointIndex.get(joint), path },
    };
  });
  return { name, samplers, channels: gltfChannels };
});

const bin = Buffer.concat(chunks);
const json = {
  asset: {
    version: '2.0',
    generator: 'fdw-engine tools/docs/make-character.mjs',
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  meshes: [
    {
      name: 'Body',
      primitives: [{ attributes, indices: indexAccessor, material: 0 }],
    },
  ],
  materials: [
    {
      name: 'Clothes',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.75,
      },
    },
  ],
  skins: [
    {
      name: 'Skeleton',
      inverseBindMatrices: inverseBinds,
      joints: joints.map((_, i) => firstJoint + i),
      skeleton: firstJoint,
    },
  ],
  animations,
  buffers: [{ byteLength: bin.length }],
  bufferViews,
  accessors,
};

let text = Buffer.from(JSON.stringify(json));
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data]);
};
writeFileSync(
  out,
  Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]),
);
console.log(
  `${out}: ${vertexCount} vertices, ${indices.length / 3} triangles, ${joints.length} joints, ${clips.length} clips`,
);
