// A fake WebGL2 context for the unit tests, outside of a browser: it records
// the calls, keeps the objects created and not deleted, and the bytes of
// the buffers.

// The WebGL2 constants: a number per name, those of the cube faces
// following each other. Installed once per test file (see installGl).
const constants: Record<string, number> = {
  TEXTURE_2D: 1,
  TEXTURE_CUBE_MAP: 2,
  TEXTURE_2D_ARRAY: 3,
  TEXTURE_3D: 4,
  TEXTURE_CUBE_MAP_POSITIVE_X: 10,
  UNPACK_FLIP_Y_WEBGL: 20,
  INVALID_INDEX: 0xffffffff,
};

/** Installs WebGL2RenderingContext, read by GL. */
export function installGl(): void {
  let next = 100;
  Object.assign(globalThis, {
    WebGL2RenderingContext: new Proxy(constants, {
      get: (table, name: string) => (table[name] ??= next++),
    }),
  });
}

export type GlCall = [string, ...unknown[]];

/** A WebGL object of the fake context. */
export interface FakeGlObject {
  readonly kind: string;
  readonly id: number;
}

export interface FakeGlOptions {
  readonly extensions?: Readonly<Record<string, object>>;
  readonly parameters?: Readonly<Record<number, unknown>>;
  // The result of the links: all succeed by default.
  readonly linkStatus?: () => boolean;
  // The uniforms and the uniform blocks the programs have: none by default.
  readonly uniforms?: readonly string[];
  readonly uniformBlocks?: readonly string[];
}

export function fakeGl(options: FakeGlOptions = {}) {
  const C = globalThis.WebGL2RenderingContext as unknown as Record<
    string,
    number
  >;
  const calls: GlCall[] = [];
  // The objects created and not deleted.
  const live = new Set<FakeGlObject>();
  const memory = new Map<FakeGlObject, Uint8Array>();
  const bound = new Map<number, FakeGlObject | null>();
  let next = 1;

  const create = (kind: string) => (): FakeGlObject => {
    const object = { kind, id: next++ };
    live.add(object);
    return object;
  };
  const remove = (object: FakeGlObject | null) => {
    if (object) {
      live.delete(object);
    }
  };
  const bytesOf = (target: number) => {
    const buffer = bound.get(target);
    const bytes = buffer && memory.get(buffer);
    if (!bytes) {
      throw new Error(`No buffer bound to ${target}`);
    }
    return bytes;
  };
  const toBytes = (data: ArrayBufferView) =>
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  const implementations: Record<string, (...args: never[]) => unknown> = {
    createBuffer: create('buffer'),
    createTexture: create('texture'),
    createFramebuffer: create('framebuffer'),
    createVertexArray: create('vertex array'),
    createShader: create('shader'),
    createProgram: create('program'),
    createQuery: create('query'),
    createSampler: create('sampler'),
    createRenderbuffer: create('renderbuffer'),
    deleteBuffer: remove,
    deleteTexture: remove,
    deleteFramebuffer: remove,
    deleteVertexArray: remove,
    deleteShader: remove,
    deleteProgram: remove,
    deleteQuery: remove,
    deleteSampler: remove,
    deleteRenderbuffer: remove,
    checkFramebufferStatus: () => C.FRAMEBUFFER_COMPLETE,
    getExtension: (name: string) => options.extensions?.[name] ?? null,
    getParameter: (name: number) =>
      options.parameters?.[name] ?? (name === C.MAX_TEXTURE_SIZE ? 4096 : 0),
    getShaderParameter: () => true,
    getProgramParameter: (_: FakeGlObject, name: number) =>
      name === C.LINK_STATUS ? (options.linkStatus?.() ?? true) : true,
    getShaderInfoLog: () => 'shader log',
    getProgramInfoLog: () => 'program log',
    getUniformBlockIndex: (_: FakeGlObject, name: string) => {
      const index = options.uniformBlocks?.indexOf(name) ?? -1;
      return index < 0 ? C.INVALID_INDEX : index;
    },
    getUniformLocation: (_: FakeGlObject, name: string) =>
      options.uniforms?.includes(name) ? { kind: 'uniform', name } : null,
    bindBuffer: (target: number, buffer: FakeGlObject | null) => {
      bound.set(target, buffer);
    },
    bufferData: (target: number, size: number | ArrayBufferView) => {
      const buffer = bound.get(target);
      if (buffer) {
        memory.set(
          buffer,
          typeof size === 'number' ? new Uint8Array(size) : toBytes(size),
        );
      }
    },
    bufferSubData: (target: number, offset: number, data: ArrayBufferView) => {
      bytesOf(target).set(toBytes(data), offset);
    },
    getBufferSubData: (
      target: number,
      offset: number,
      data: ArrayBufferView,
    ) => {
      const bytes = bytesOf(target);
      toBytes(data).set(bytes.subarray(offset, offset + data.byteLength));
    },
    copyBufferSubData: (
      read: number,
      write: number,
      readOffset: number,
      writeOffset: number,
      size: number,
    ) => {
      bytesOf(write).set(
        bytesOf(read).slice(readOffset, readOffset + size),
        writeOffset,
      );
    },
  };

  // Every other function is recorded and returns undefined.
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => {
      if (name === 'then') {
        return undefined;
      }
      return (...args: never[]) => {
        calls.push([name, ...args]);
        return implementations[name]?.(...args);
      };
    },
  }) as unknown as WebGL2RenderingContext;

  // The calls of a name, without their name.
  const named = (name: string) =>
    calls.filter((call) => call[0] === name).map((call) => call.slice(1));
  // The bytes of a buffer.
  const bytes = (buffer: WebGLBuffer) =>
    memory.get(buffer as unknown as FakeGlObject);
  // The live objects of a kind.
  const alive = (kind: string) =>
    [...live].filter((object) => object.kind === kind);

  return { gl, calls, named, bytes, alive, C };
}
