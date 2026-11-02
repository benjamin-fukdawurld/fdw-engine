import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRun } from '@fdw/engine-backend/testing';
import {
  addonPath,
  BindingKinds,
  BufferUsageFlags,
  Commands,
  loadVulkanAddon,
  TextureUsageFlags,
  type ContextHandle,
} from './addon';
import { dxcArguments } from './shader/HlslCodegen';

// The checks of the addon on what it is given (audit §4.1, §4.3), on the
// GPU: when the addon is built (it needs the SDK).
const built = canRun(
  'vulkan',
  existsSync(addonPath()),
  'the Vulkan addon is not built (VULKAN_SDK)',
);

describe.skipIf(!built)('the Vulkan addon', () => {
  let addon: ReturnType<typeof loadVulkanAddon>;
  const hlsl = '[numthreads(1, 1, 1)] void cs_main() {}';
  const args = dxcArguments('compute', 'cs_main', 'vulkan', hlsl);
  let context: ContextHandle;
  beforeAll(() => {
    addon = loadVulkanAddon();
    context = addon.createContext(true, 'tests');
  });
  afterAll(() => {
    if (context) addon.destroyContext(context);
  });

  it('takes the DXC arguments as strings only, at most 200', () => {
    expect(() =>
      addon.compileHlsl('x', ['-T', 1 as unknown as string]),
    ).toThrow(TypeError);
    expect(() => addon.compileHlsl('x', 'cs_6_0' as never)).toThrow(TypeError);
    expect(() =>
      addon.compileHlsl(
        'x',
        Array.from({ length: 201 }, () => '-O3'),
      ),
    ).toThrow(TypeError);
    expect(() =>
      addon.createShader(context, hlsl, [null as unknown as string]),
    ).toThrow(TypeError);
    expect(() =>
      addon.createShaderFromCode(context, new Uint8Array(20), [
        undefined as unknown as string,
      ]),
    ).toThrow(TypeError);
  });

  it('refuses the code that is not SPIR-V, before the driver', () => {
    const code = addon.compileHlsl(hlsl, args);
    const corrupted = code.slice();
    corrupted[0] ^= 0xff;
    expect(() => addon.createShaderFromCode(context, corrupted, args)).toThrow(
      /not SPIR-V/,
    );
    expect(() =>
      addon.createShaderFromCode(context, code.subarray(0, 6), args),
    ).toThrow(/32-bit words/);
    addon.destroyShader(addon.createShaderFromCode(context, code, args));
    expect(addon.takeMessages(context)).toEqual([]);
  });

  it('starts each pass without the pipeline and groups of the previous one', () => {
    const shader = addon.createShader(context, hlsl, args, 'empty');
    const pipeline = addon.createComputePipeline(context, shader, [], 'empty');
    const id = addon.pipelineId(pipeline);
    // The pipeline set in a pass, dispatched in the next one.
    const words = new Uint32Array([
      Commands.beginComputePass,
      Commands.setPipeline,
      id,
      Commands.endComputePass,
      Commands.beginComputePass,
      Commands.dispatch,
      1,
      1,
      1,
      Commands.endComputePass,
    ]);
    expect(() => addon.submit(context, words)).toThrow(
      /No compute pipeline set/,
    );
    // Set in the pass: dispatched.
    addon.submit(
      context,
      new Uint32Array([
        Commands.beginComputePass,
        Commands.setPipeline,
        id,
        Commands.dispatch,
        1,
        1,
        1,
        Commands.endComputePass,
      ]),
    );
    addon.waitIdle(context);
    addon.destroyPipeline(pipeline);
    addon.destroyShader(shader);
    expect(addon.takeMessages(context)).toEqual([]);
  });

  it('refuses the queries out of the pool, without overflow', (test) => {
    if (!addon.timestampsSupported(context)) {
      test.skip();
    }
    const pool = addon.createQueryPool(context, 4);
    const id = addon.queryPoolId(pool);
    // first + count wraps around to 0 in 32 bits.
    for (const words of [
      [Commands.writeTimestamp, id, 0xffffffff],
      [Commands.writeTimestamp, id, 4],
      [Commands.resetQueries, id, 1, 0xffffffff],
      [Commands.resetQueries, id, 3, 2],
    ]) {
      expect(() => addon.submit(context, new Uint32Array(words))).toThrow(
        /Queries out of the pool/,
      );
    }
    expect(() =>
      addon.readQueryPool(pool, 0xffffffff, 1, new Float64Array(1)),
    ).toThrow(/Queries out of the pool/);
    // Inside: written and read.
    addon.submit(
      context,
      new Uint32Array([
        Commands.resetQueries,
        id,
        0,
        4,
        Commands.writeTimestamp,
        id,
        3,
      ]),
    );
    addon.waitIdle(context);
    const nanoseconds = new Float64Array(1);
    expect(addon.readQueryPool(pool, 3, 1, nanoseconds)).toBe(true);
    addon.destroyQueryPool(pool);
  });

  it('copies the depth of depth24plus-stencil8, 4 bytes per pixel', () => {
    const texture = addon.createTexture(
      context,
      'depth24plus-stencil8',
      '2d',
      4,
      2,
      1,
      1,
      1,
      TextureUsageFlags['render-attachment'] |
        TextureUsageFlags['copy-dst'] |
        TextureUsageFlags['copy-src'],
      'depth',
    );
    expect(() =>
      addon.writeTexture(texture, new Float32Array(4 * 2 * 2)),
    ).toThrow(/takes 32 bytes/);
    addon.writeTexture(texture, new Float32Array(4 * 2).fill(0.5));
    addon.waitIdle(context);
    addon.destroyTexture(texture);
    expect(() => addon.textureId(texture)).toThrow(/destroyed/);
    expect(addon.takeMessages(context)).toEqual([]);
  });
});

// The barriers between the uses of a resource (native/src/tracking.cpp),
// checked by the synchronization validation of the layer (audit §4.1). It is
// set by the environment, read when the context is created; the heuristic
// makes it see the accesses of the shaders to their groups.
describe.skipIf(!built)('the barriers of the Vulkan addon', () => {
  let addon: ReturnType<typeof loadVulkanAddon>;
  let context: ContextHandle;
  const settings = {
    VK_KHRONOS_VALIDATION_VALIDATE_SYNC: 'true',
    VK_KHRONOS_VALIDATION_SYNCVAL_SHADER_ACCESSES_HEURISTIC: 'true',
  };
  beforeAll(() => {
    addon = loadVulkanAddon();
    const before = Object.keys(settings).map((name) => process.env[name]);
    Object.assign(process.env, settings);
    try {
      context = addon.createContext(true, 'tests');
    } finally {
      Object.keys(settings).forEach((name, i) => {
        if (before[i] === undefined) delete process.env[name];
        else process.env[name] = before[i];
      });
    }
  });
  afterAll(() => {
    if (context) addon.destroyContext(context);
  });

  it('makes each read wait for the last write, not only for the reads before', (test) => {
    if (!addon.validationEnabled(context)) {
      test.skip();
    }
    const hlsl = `
      struct Data { float4 color; };
      [[vk::binding(0, 0)]] ConstantBuffer<Data> data;
      [[vk::binding(0, 1)]] StructuredBuffer<float4> source;
      [[vk::binding(1, 1)]] RWStructuredBuffer<float4> result;
      float4 vs_main(uint id : SV_VertexID) : SV_Position {
        return float4(float2((id << 1) & 2, id & 2) * 2 - 1, 0, 1);
      }
      float4 fs_main() : SV_Target { return data.color; }
      [numthreads(1, 1, 1)] void cs_main() { result[0] = source[0] * 2; }`;
    const shader = (stage: 'vertex' | 'fragment' | 'compute', entry: string) =>
      addon.createShader(
        context,
        hlsl,
        dxcArguments(stage, entry, 'vulkan', hlsl),
      );
    const vertex = shader('vertex', 'vs_main');
    const fragment = shader('fragment', 'fs_main');
    const compute = shader('compute', 'cs_main');
    const uniforms = addon.createGroupLayout(context, [
      { binding: 0, kind: BindingKinds.uniform },
    ]);
    const storage = addon.createGroupLayout(context, [
      { binding: 0, kind: BindingKinds.storageRead },
      { binding: 1, kind: BindingKinds.storageReadWrite },
    ]);
    const draw = addon.createRenderPipeline(context, {
      vertex,
      fragment,
      groups: [uniforms],
      vertexBuffers: [],
      topology: 'triangle-list',
      cullMode: 'none',
      frontFace: 'ccw',
      targets: [{ format: 'rgba8unorm' }],
    });
    // The storage group in group 1, as the shader declares it.
    const dispatch = addon.createComputePipeline(context, compute, [
      null,
      storage,
    ]);

    const staging = addon.createBuffer(
      context,
      16,
      BufferUsageFlags['copy-src'],
    );
    const data = addon.createBuffer(
      context,
      16,
      BufferUsageFlags.uniform |
        BufferUsageFlags.storage |
        BufferUsageFlags['copy-dst'],
    );
    const result = addon.createBuffer(
      context,
      16,
      BufferUsageFlags.storage | BufferUsageFlags['copy-src'],
    );
    const target = addon.createTexture(
      context,
      'rgba8unorm',
      '2d',
      2,
      2,
      1,
      1,
      1,
      TextureUsageFlags['render-attachment'] | TextureUsageFlags['copy-src'],
    );
    addon.writeBuffer(staging, 0, new Float32Array([1, 0, 1, 1]));
    const drawGroup = addon.createGroup(context, uniforms, [
      { binding: 0, object: addon.bufferId(data) },
    ]);
    const dispatchGroup = addon.createGroup(context, storage, [
      { binding: 0, object: addon.bufferId(data) },
      { binding: 1, object: addon.bufferId(result) },
    ]);
    // A copy writes the buffer, a fragment shader reads it as uniforms,
    // then a compute shader as storage: the last read waits for the copy
    // too, not only for the fragment shader.
    addon.submit(
      context,
      new Uint32Array([
        Commands.copyBuffer,
        addon.bufferId(staging),
        0,
        0,
        addon.bufferId(data),
        0,
        0,
        16,
        0,
        // A target cleared to black, no resolve target, no depth.
        Commands.beginRenderPass,
        1,
        addon.textureId(target),
        ...[0, 0, 0, 0, 0, 0],
        ...[0, 0, 0],
        Commands.setPipeline,
        addon.pipelineId(draw),
        Commands.setGroup,
        0,
        addon.groupId(drawGroup),
        Commands.draw,
        3,
        1,
        0,
        Commands.endRenderPass,
        Commands.beginComputePass,
        Commands.setPipeline,
        addon.pipelineId(dispatch),
        Commands.setGroup,
        1,
        addon.groupId(dispatchGroup),
        Commands.dispatch,
        1,
        1,
        1,
        Commands.endComputePass,
      ]),
    );
    const pixels = addon.readTexture(target, 0, 0, 1, 1);
    const values = addon.readBuffer(result, 0, 16);
    addon.waitIdle(context);
    const pixel = new Uint8Array(4);
    addon.readTake(context, pixels, pixel);
    const doubled = new Float32Array(4);
    addon.readTake(context, values, doubled);
    expect([...pixel]).toEqual([255, 0, 255, 255]);
    expect([...doubled]).toEqual([2, 0, 2, 2]);
    expect(addon.takeMessages(context)).toEqual([]);

    for (const group of [drawGroup, dispatchGroup]) addon.destroyGroup(group);
    for (const buffer of [staging, data, result]) addon.destroyBuffer(buffer);
    addon.destroyTexture(target);
    for (const pipeline of [draw, dispatch]) addon.destroyPipeline(pipeline);
    for (const s of [vertex, fragment, compute]) addon.destroyShader(s);
    addon.waitIdle(context);
    expect(addon.takeMessages(context)).toEqual([]);
  });
});
