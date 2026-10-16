import { createRequire } from 'node:module';

// The Node-API addon (native/src/node_vulkan.c), built by scripts/build.mjs.

/** Opaque handles of the addon. */
export type ContextHandle = { readonly __context: unique symbol };
export type BufferHandle = { readonly __buffer: unique symbol };
export type TextureHandle = { readonly __texture: unique symbol };
export type SamplerHandle = { readonly __sampler: unique symbol };
export type ShaderHandle = { readonly __shader: unique symbol };
export type GroupLayoutHandle = { readonly __groupLayout: unique symbol };
export type GroupHandle = { readonly __group: unique symbol };
export type PipelineHandle = { readonly __pipeline: unique symbol };
export type SwapchainHandle = { readonly __swapchain: unique symbol };
export type QueryPoolHandle = { readonly __queryPool: unique symbol };

/**
 * A native window, as NativeWindow.nativeHandle of @fdw/engine-native gives
 * it: the window system and its handles.
 */
export interface NativeWindowHandle {
  readonly system: 'x11' | 'wayland' | 'win32' | 'cocoa' | 'unknown';
  readonly display: bigint;
  readonly window: bigint;
}

/** How a group binds a resource (FDW_VK_BINDING_*). */
export const BindingKinds = {
  uniform: 0,
  texture: 1,
  sampler: 2,
  storageRead: 3,
  storageReadWrite: 4,
} as const;

/** A render pipeline, as createRenderPipeline takes it. */
export interface NativeRenderPipelineOptions {
  readonly vertex: ShaderHandle;
  readonly fragment?: ShaderHandle;
  // The layouts of the groups 0, 1… (null for an empty group).
  readonly groups: readonly (GroupLayoutHandle | null)[];
  readonly vertexBuffers: readonly {
    readonly stride: number;
    readonly perInstance: boolean;
    readonly attributes: readonly {
      readonly location: number;
      readonly format: string;
      readonly offset: number;
    }[];
  }[];
  readonly topology: string;
  readonly cullMode: string;
  readonly frontFace: string;
  readonly depthFormat?: string;
  readonly depthWrite?: boolean;
  readonly depthCompare?: string;
  readonly depthBias?: number;
  readonly depthBiasSlopeScale?: number;
  readonly targets: readonly {
    readonly format: string;
    readonly blend?: {
      readonly color: BlendComponentOptions;
      readonly alpha: BlendComponentOptions;
    };
  }[];
  readonly sampleCount?: number;
  readonly label?: string;
}

interface BlendComponentOptions {
  readonly srcFactor: string;
  readonly dstFactor: string;
  readonly operation: string;
}

export interface VulkanAddon {
  createContext(validation: boolean, application?: string): ContextHandle;
  destroyContext(context: ContextHandle): void;
  deviceName(context: ContextHandle): string;
  validationEnabled(context: ContextHandle): boolean;
  // The validation messages since the last call.
  takeMessages(context: ContextHandle): string[];
  waitIdle(context: ContextHandle): void;
  flush(context: ContextHandle): void;

  createBuffer(
    context: ContextHandle,
    size: number,
    usage: number,
    label?: string,
  ): BufferHandle;
  destroyBuffer(buffer: BufferHandle): void;
  writeBuffer(
    buffer: BufferHandle,
    offset: number,
    data: ArrayBufferView,
  ): void;
  // A ticket, ready when readReady says so.
  readBuffer(buffer: BufferHandle, offset: number, size: number): number;
  readReady(context: ContextHandle, ticket: number): boolean;
  readTake(
    context: ContextHandle,
    ticket: number,
    target: ArrayBufferView,
  ): void;
  bufferId(buffer: BufferHandle): number;

  createTexture(
    context: ContextHandle,
    format: string,
    type: string,
    width: number,
    height: number,
    layers: number,
    sampleCount: number,
    mipLevelCount: number,
    usage: number,
    label?: string,
  ): TextureHandle;
  destroyTexture(texture: TextureHandle): void;
  textureId(texture: TextureHandle): number;
  // Every layer, rows from the top, tightly packed.
  writeTexture(texture: TextureHandle, data: ArrayBufferView): void;
  // The layers [layer, layer + layerCount) of a level, rows from the top,
  // tightly packed (rows of blocks for the compressed formats); the other
  // levels kept.
  writeTextureLevel(
    texture: TextureHandle,
    data: ArrayBufferView,
    level: number,
    layer: number,
    layerCount: number,
  ): void;
  // Computes the levels after the first one, in the order of the queue.
  generateMipmaps(texture: TextureHandle): void;
  // A ticket for the pixels of a region of the first layer (from the top
  // left corner), as readBuffer.
  readTexture(
    texture: TextureHandle,
    x: number,
    y: number,
    width: number,
    height: number,
  ): number;

  createSampler(
    context: ContextHandle,
    minFilter: string,
    magFilter: string,
    mipmapFilter: string,
    wrapU: string,
    wrapV: string,
    wrapW: string,
    maxAnisotropy: number,
    compare: string | undefined,
    label?: string,
  ): SamplerHandle;
  destroySampler(sampler: SamplerHandle): void;
  // The highest anisotropy of the samplers (1: none).
  maxAnisotropy(context: ContextHandle): number;
  // The color attachments of a render pass (at most 8).
  maxColorAttachments(context: ContextHandle): number;
  // Whether the color targets of a pipeline can blend differently.
  independentBlend(context: ContextHandle): boolean;
  // Whether the device can write and sample textures of a format.
  formatSupported(context: ContextHandle, format: string): boolean;
  samplerId(sampler: SamplerHandle): number;
  // Whether the queue writes timestamps.
  timestampsSupported(context: ContextHandle): boolean;
  // A pool of `count` timestamp queries.
  createQueryPool(context: ContextHandle, count: number): QueryPoolHandle;
  destroyQueryPool(pool: QueryPoolHandle): void;
  queryPoolId(pool: QueryPoolHandle): number;
  // The timestamps of queries [first, first + count), in nanoseconds, into
  // `nanoseconds`, without waiting: whether all were available.
  readQueryPool(
    pool: QueryPoolHandle,
    first: number,
    count: number,
    nanoseconds: Float64Array,
  ): boolean;

  // Replays the commands (Commands) and submits them.
  submit(context: ContextHandle, words: Uint32Array): void;

  // Compiles an entry point of an HLSL module (DXC arguments of
  // dxcArguments) into a shader module.
  createShader(
    context: ContextHandle,
    hlsl: string,
    args: readonly string[],
    label?: string,
  ): ShaderHandle;
  destroyShader(shader: ShaderHandle): void;
  createGroupLayout(
    context: ContextHandle,
    bindings: readonly { binding: number; kind: number }[],
  ): GroupLayoutHandle;
  createGroup(
    context: ContextHandle,
    layout: GroupLayoutHandle,
    entries: readonly { binding: number; object: number }[],
  ): GroupHandle;
  destroyGroup(group: GroupHandle): void;
  groupId(group: GroupHandle): number;
  createRenderPipeline(
    context: ContextHandle,
    options: NativeRenderPipelineOptions,
  ): PipelineHandle;
  createComputePipeline(
    context: ContextHandle,
    shader: ShaderHandle,
    groups: readonly (GroupLayoutHandle | null)[],
    label?: string,
  ): PipelineHandle;
  destroyPipeline(pipeline: PipelineHandle): void;

  createSwapchain(
    context: ContextHandle,
    window: NativeWindowHandle,
    width: number,
    height: number,
    vsync: boolean,
  ): SwapchainHandle;
  destroySwapchain(swapchain: SwapchainHandle): void;
  swapchainFormat(swapchain: SwapchainHandle): string;
  // The texture handles of the images, new after a recreation.
  swapchainImages(swapchain: SwapchainHandle): TextureHandle[];
  acquireImage(
    swapchain: SwapchainHandle,
    width: number,
    height: number,
  ): { index: number; recreated: boolean; width: number; height: number };
  present(swapchain: SwapchainHandle): void;
  pipelineId(pipeline: PipelineHandle): number;
}

// The usages of createBuffer (include/fdw/vulkan.h).
export const BufferUsageFlags = {
  uniform: 1 << 0,
  storage: 1 << 1,
  vertex: 1 << 2,
  index: 1 << 3,
  indirect: 1 << 4,
  'copy-src': 1 << 5,
  'copy-dst': 1 << 6,
} as const;

// The usages of createTexture.
export const TextureUsageFlags = {
  sampled: 1 << 0,
  storage: 1 << 1,
  'render-attachment': 1 << 2,
  'copy-src': 1 << 3,
  'copy-dst': 1 << 4,
} as const;

// The opcodes of the commands of submit (FDW_VK_CMD_* of
// include/fdw/vulkan.h).
export const Commands = {
  beginRenderPass: 1,
  endRenderPass: 2,
  copyBuffer: 3,
  copyTexture: 4,
  setPipeline: 5,
  setGroup: 6,
  setVertexBuffer: 7,
  setIndexBuffer: 8,
  draw: 9,
  drawIndexed: 10,
  setViewport: 11,
  beginComputePass: 12,
  endComputePass: 13,
  dispatch: 14,
  dispatchIndirect: 15,
  resetQueries: 16,
  writeTimestamp: 17,
  generateMipmaps: 18,
} as const;

let addon: VulkanAddon | undefined;

/** The path of the addon: build/fdw_vulkan.node, or FDW_VULKAN_ADDON. */
export const addonPath = (): string =>
  process.env['FDW_VULKAN_ADDON'] ??
  new URL('../build/fdw_vulkan.node', import.meta.url).pathname;

/** Loads the addon. */
export function loadVulkanAddon(): VulkanAddon {
  if (!addon) {
    const require = createRequire(import.meta.url);
    const path = addonPath();
    try {
      addon = require(path) as VulkanAddon;
    } catch (error) {
      throw new Error(
        `The native addon of @fdw/engine-vulkan is not built (${path}): run "node packages/engine-vulkan/scripts/build.mjs" with the Vulkan SDK`,
        { cause: error },
      );
    }
  }
  return addon;
}
