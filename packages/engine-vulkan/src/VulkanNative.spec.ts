import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRun } from '@fdw/engine-backend/testing';
import {
  addonPath,
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
