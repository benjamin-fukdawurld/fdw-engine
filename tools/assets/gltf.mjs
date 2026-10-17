// Reads and writes glTF 2.0 files for the asset tools: a document is the
// JSON with its accessors decoded into typed arrays (`doc.data[i]`), and
// its images as bytes (`doc.images[i]`, with their MIME type). Writing
// rebuilds one buffer from the accessors still referenced, and embeds the
// images: a single .glb. Enough for the models the tools prepare, not a
// general library (no sparse accessors, no extensions with buffers).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const ComponentArrays = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const ComponentTypes = new Map(
  Object.entries(ComponentArrays).map(([type, array]) => [array, +type]),
);
export const TypeSizes = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const Mime = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Reads a .gltf (with its .bin and image files) or a .glb. */
export function readGltf(path) {
  const file = readFileSync(path);
  let json;
  let glbBin;
  if (file.readUInt32LE(0) === 0x46546c67) {
    let offset = 12;
    while (offset < file.length) {
      const length = file.readUInt32LE(offset);
      const type = file.readUInt32LE(offset + 4);
      const chunk = file.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) glbBin = chunk;
      offset += 8 + length;
    }
  } else {
    json = JSON.parse(file.toString('utf8'));
  }
  const base = dirname(path);
  const buffers = (json.buffers ?? []).map((buffer) =>
    buffer.uri === undefined
      ? glbBin
      : buffer.uri.startsWith('data:')
        ? Buffer.from(buffer.uri.split(',')[1], 'base64')
        : readFileSync(join(base, decodeURIComponent(buffer.uri))),
  );
  const view = (index) => {
    const v = json.bufferViews[index];
    const buffer = buffers[v.buffer];
    return {
      bytes: buffer.subarray(
        v.byteOffset ?? 0,
        (v.byteOffset ?? 0) + v.byteLength,
      ),
      stride: v.byteStride,
    };
  };
  const data = (json.accessors ?? []).map((accessor) => {
    const Array = ComponentArrays[accessor.componentType];
    const size = TypeSizes[accessor.type];
    const out = new Array(accessor.count * size);
    if (accessor.sparse) throw new Error('sparse accessors are not supported');
    if (accessor.bufferView === undefined) return out;
    const { bytes, stride } = view(accessor.bufferView);
    const element = Array.BYTES_PER_ELEMENT * size;
    const step = stride ?? element;
    const start = accessor.byteOffset ?? 0;
    // Copied element by element: the views of a buffer are not aligned for
    // every typed array, and may be interleaved.
    const target = new Uint8Array(out.buffer);
    for (let i = 0; i < accessor.count; i++) {
      target.set(
        bytes.subarray(start + i * step, start + i * step + element),
        i * element,
      );
    }
    return out;
  });
  const images = (json.images ?? []).map((image) => {
    if (image.bufferView !== undefined) {
      return {
        bytes: Buffer.from(view(image.bufferView).bytes),
        mimeType: image.mimeType,
      };
    }
    if (image.uri.startsWith('data:')) {
      const [head, body] = image.uri.split(',');
      return {
        bytes: Buffer.from(body, 'base64'),
        mimeType: head.slice(5).split(';')[0],
      };
    }
    const file = decodeURIComponent(image.uri);
    return {
      bytes: readFileSync(join(base, file)),
      mimeType: Mime[extname(file).toLowerCase()],
    };
  });
  return { json, data, images };
}

/**
 * Adds an accessor holding `array` (a typed array) to the document and
 * returns its index. `type` is the glTF type (VEC3...); min and max are
 * written for positions and animation inputs.
 */
export function addAccessor(doc, array, type, extra = {}) {
  doc.json.accessors ??= [];
  const size = TypeSizes[type];
  doc.json.accessors.push({
    componentType: ComponentTypes.get(array.constructor),
    count: array.length / size,
    type,
    ...extra,
  });
  doc.data.push(array);
  return doc.json.accessors.length - 1;
}

/**
 * The primitives of a mesh in plain arrays (see mesh.mjs), with only the
 * attributes named (all by default).
 */
export function primitivesOf(doc, mesh, names) {
  return doc.json.meshes[mesh].primitives.map((primitive) => {
    const attributes = {};
    for (const [name, accessor] of Object.entries(primitive.attributes)) {
      if (!names || names.includes(name)) attributes[name] = doc.data[accessor];
    }
    const indices = doc.data[primitive.indices];
    return {
      attributes,
      indices:
        indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
      material: primitive.material,
    };
  });
}

/**
 * Adds a mesh made of primitives in plain arrays and returns its index.
 * The indices are written in 16 bits when they fit.
 */
export function addMesh(doc, name, primitives) {
  doc.json.meshes ??= [];
  doc.json.meshes.push({
    name,
    primitives: primitives.map((primitive) => {
      const attributes = {};
      for (const [attribute, array] of Object.entries(primitive.attributes)) {
        const size = array.length / (primitive.attributes.POSITION.length / 3);
        const type = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' }[size];
        attributes[attribute] = addAccessor(
          doc,
          array,
          type,
          attribute === 'POSITION' ? bounds(array, 3) : {},
        );
      }
      const vertexCount = primitive.attributes.POSITION.length / 3;
      const indices =
        vertexCount <= 65536
          ? Uint16Array.from(primitive.indices)
          : primitive.indices;
      return {
        attributes,
        indices: addAccessor(doc, indices, 'SCALAR'),
        ...(primitive.material !== undefined
          ? { material: primitive.material }
          : {}),
      };
    }),
  });
  return doc.json.meshes.length - 1;
}

/**
 * A new document with the materials, textures, samplers and images of
 * `source`, and no node or mesh: what a tool fills with its own.
 */
export function documentWithMaterials(source) {
  const { materials, textures, samplers, images, extensionsUsed } = source.json;
  return {
    json: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      accessors: [],
      ...(materials ? { materials: structuredClone(materials) } : {}),
      ...(textures ? { textures: structuredClone(textures) } : {}),
      ...(samplers ? { samplers: structuredClone(samplers) } : {}),
      ...(images ? { images: structuredClone(images) } : {}),
      ...(extensionsUsed ? { extensionsUsed: [...extensionsUsed] } : {}),
    },
    data: [],
    images: [...source.images],
  };
}

/**
 * Copies a mesh of `source` into `doc`, with its materials, textures,
 * samplers and images; returns its index in `doc`.
 */
export function importMesh(doc, source, mesh) {
  const json = doc.json;
  json.materials ??= [];
  json.textures ??= [];
  json.images ??= [];
  json.samplers ??= [];
  const images = new Map();
  const samplers = new Map();
  const textures = new Map();
  const materials = new Map();
  const texture = (index) => {
    if (!textures.has(index)) {
      const t = structuredClone(source.json.textures[index]);
      if (t.source !== undefined) {
        if (!images.has(t.source)) {
          json.images.push(structuredClone(source.json.images[t.source]));
          doc.images.push(source.images[t.source]);
          images.set(t.source, json.images.length - 1);
        }
        t.source = images.get(t.source);
      }
      if (t.sampler !== undefined) {
        if (!samplers.has(t.sampler)) {
          json.samplers.push(structuredClone(source.json.samplers[t.sampler]));
          samplers.set(t.sampler, json.samplers.length - 1);
        }
        t.sampler = samplers.get(t.sampler);
      }
      json.textures.push(t);
      textures.set(index, json.textures.length - 1);
    }
    return textures.get(index);
  };
  const material = (index) => {
    if (!materials.has(index)) {
      const m = structuredClone(source.json.materials[index]);
      textureRefs(m, (ref) => (ref.index = texture(ref.index)));
      json.materials.push(m);
      materials.set(index, json.materials.length - 1);
    }
    return materials.get(index);
  };
  const primitives = primitivesOf(source, mesh).map((primitive) => ({
    ...primitive,
    material:
      primitive.material === undefined
        ? undefined
        : material(primitive.material),
  }));
  return addMesh(doc, source.json.meshes[mesh].name, primitives);
}

/**
 * Copies the animation `name` of `source` into `doc`, its channels
 * retargeted to the nodes of `doc` with the same names (the skeletons must
 * match: same joints, same rest proportions). Returns the number of
 * channels copied, those whose node `doc` lacks being left out.
 */
export function importAnimation(doc, source, name, rename = name) {
  const animation = source.json.animations.find((a) => a.name === name);
  if (!animation) throw new Error(`no animation ${name}`);
  const nodes = new Map(doc.json.nodes.map((node, i) => [node.name, i]));
  const samplers = [];
  const channels = [];
  const copied = new Map();
  const accessor = (index) => {
    if (!copied.has(index)) {
      const {
        bufferView: _view,
        byteOffset: _offset,
        ...rest
      } = source.json.accessors[index];
      void _view;
      void _offset;
      doc.json.accessors.push(rest);
      doc.data.push(source.data[index]);
      copied.set(index, doc.json.accessors.length - 1);
    }
    return copied.get(index);
  };
  for (const channel of animation.channels) {
    const node = nodes.get(source.json.nodes[channel.target.node]?.name);
    if (node === undefined) continue;
    const sampler = animation.samplers[channel.sampler];
    samplers.push({
      input: accessor(sampler.input),
      output: accessor(sampler.output),
      ...(sampler.interpolation
        ? { interpolation: sampler.interpolation }
        : {}),
    });
    channels.push({
      sampler: samplers.length - 1,
      target: { node, path: channel.target.path },
    });
  }
  (doc.json.animations ??= []).push({ name: rename, samplers, channels });
  return channels.length;
}

/** Adds a node under the scene (or under `parent`) and returns its index. */
export function addNode(doc, node, parent) {
  doc.json.nodes.push(node);
  const index = doc.json.nodes.length - 1;
  if (parent === undefined) doc.json.scenes[0].nodes.push(index);
  else (doc.json.nodes[parent].children ??= []).push(index);
  return index;
}

/** The min and max of each component of a VEC accessor. */
export function bounds(array, size) {
  const min = new Array(size).fill(Infinity);
  const max = new Array(size).fill(-Infinity);
  for (let i = 0; i < array.length; i += size) {
    for (let c = 0; c < size; c++) {
      min[c] = Math.min(min[c], array[i + c]);
      max[c] = Math.max(max[c], array[i + c]);
    }
  }
  return { min, max };
}

// The texture references of a material: every `{ index }` under it.
function textureRefs(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.index === 'number' && !Array.isArray(value)) visit(value);
  for (const child of Object.values(value)) textureRefs(child, visit);
}

/** Leaves out the materials no primitive uses, then the textures no material does. */
function pruneMaterials(json) {
  if (!json.materials) return;
  const used = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.material !== undefined) used.add(primitive.material);
    }
  }
  const materials = new Map();
  json.materials = json.materials.filter((material, i) => {
    if (!used.has(i)) return false;
    materials.set(i, materials.size);
    return true;
  });
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.material !== undefined) {
        primitive.material = materials.get(primitive.material);
      }
    }
  }
  if (!json.textures) return;
  const usedTextures = new Set();
  json.materials.forEach((m) =>
    textureRefs(m, (ref) => usedTextures.add(ref.index)),
  );
  const textures = new Map();
  json.textures = json.textures.filter((texture, i) => {
    if (!usedTextures.has(i)) return false;
    textures.set(i, textures.size);
    return true;
  });
  json.materials.forEach((m) =>
    textureRefs(m, (ref) => (ref.index = textures.get(ref.index))),
  );
}

/**
 * The indices of the accessors, images and other objects still referenced,
 * and the document rewritten to use only them: what the edits left behind
 * is not written.
 */
function compact(doc) {
  const { json } = doc;
  pruneMaterials(json);
  const usedAccessors = new Set();
  const usedImages = new Set();
  const useAccessor = (i) => i !== undefined && usedAccessors.add(i);
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      Object.values(primitive.attributes).forEach(useAccessor);
      useAccessor(primitive.indices);
      for (const target of primitive.targets ?? []) {
        Object.values(target).forEach(useAccessor);
      }
    }
  }
  for (const skin of json.skins ?? []) useAccessor(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers) {
      useAccessor(sampler.input);
      useAccessor(sampler.output);
    }
  }
  for (const texture of json.textures ?? []) {
    if (texture.source !== undefined) usedImages.add(texture.source);
    for (const extension of Object.values(texture.extensions ?? {})) {
      if (extension.source !== undefined) usedImages.add(extension.source);
    }
  }
  const remap = (used) => {
    const map = new Map();
    [...used].sort((a, b) => a - b).forEach((old, i) => map.set(old, i));
    return map;
  };
  const accessors = remap(usedAccessors);
  const images = remap(usedImages);
  const accessor = (i) => (i === undefined ? undefined : accessors.get(i));
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const key of Object.keys(primitive.attributes)) {
        primitive.attributes[key] = accessor(primitive.attributes[key]);
      }
      if (primitive.indices !== undefined) {
        primitive.indices = accessor(primitive.indices);
      }
      for (const target of primitive.targets ?? []) {
        for (const key of Object.keys(target))
          target[key] = accessor(target[key]);
      }
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = accessor(skin.inverseBindMatrices);
    }
  }
  for (const animation of json.animations ?? []) {
    for (const sampler of animation.samplers) {
      sampler.input = accessor(sampler.input);
      sampler.output = accessor(sampler.output);
    }
  }
  for (const texture of json.textures ?? []) {
    if (texture.source !== undefined)
      texture.source = images.get(texture.source);
    for (const extension of Object.values(texture.extensions ?? {})) {
      if (extension.source !== undefined) {
        extension.source = images.get(extension.source);
      }
    }
  }
  const order = (map) =>
    [...map.entries()].sort((a, b) => a[1] - b[1]).map(([old]) => old);
  return {
    accessors: order(accessors).map((i) => [json.accessors[i], doc.data[i]]),
    images: order(images).map((i) => [json.images[i], doc.images[i]]),
  };
}

/** Writes the document as a .glb: one buffer, the images embedded. */
export function writeGlb(doc, path) {
  const { accessors, images } = compact(doc);
  const json = structuredClone(doc.json);
  const chunks = [];
  let length = 0;
  const bufferViews = [];
  const push = (bytes, target) => {
    const padding = (4 - (length % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      length += padding;
    }
    bufferViews.push({
      buffer: 0,
      byteOffset: length,
      byteLength: bytes.length,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes);
    length += bytes.length;
    return bufferViews.length - 1;
  };
  const indices = new Set();
  const vertices = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices !== undefined) indices.add(primitive.indices);
      Object.values(primitive.attributes).forEach((i) => vertices.add(i));
    }
  }
  json.accessors = accessors.map(([accessor, array], i) => {
    const { byteOffset: _offset, sparse: _sparse, ...rest } = accessor;
    void _offset;
    void _sparse;
    return {
      ...rest,
      bufferView: push(
        Buffer.from(array.buffer, array.byteOffset, array.byteLength),
        indices.has(i) ? 34963 : vertices.has(i) ? 34962 : undefined,
      ),
    };
  });
  json.images = images.map(([image, { bytes, mimeType }]) => {
    const { uri: _uri, ...rest } = image;
    void _uri;
    return { ...rest, mimeType, bufferView: push(bytes) };
  });
  if (json.images.length === 0) delete json.images;
  json.bufferViews = bufferViews;
  json.buffers = [{ byteLength: length }];
  json.asset = { version: '2.0', generator: 'fdw-engine tools/assets' };

  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([
    text,
    Buffer.alloc((4 - (text.length % 4)) % 4, 0x20),
  ]);
  const bin = Buffer.concat(chunks);
  const binChunk = Buffer.concat([
    bin,
    Buffer.alloc((4 - (bin.length % 4)) % 4),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHeader = (chunk, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(chunk.length, 0);
    h.writeUInt32LE(type, 4);
    return h;
  };
  writeFileSync(
    path,
    Buffer.concat([
      header,
      chunkHeader(jsonChunk, 0x4e4f534a),
      jsonChunk,
      chunkHeader(binChunk, 0x004e4942),
      binChunk,
    ]),
  );
}
