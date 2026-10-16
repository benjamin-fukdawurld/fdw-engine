// Textures and samplers.

#include "context.hpp"

#include <algorithm>
#include <cstring>
#include <string_view>

using namespace fdw;

namespace {

// The formats of the engine (GpuTextureFormat). depth24plus is a 32-bit
// float depth, available everywhere (WebGPU allows any format of at least
// 24 bits).
constexpr FormatInfo formats[] = {
    {"r8unorm", VK_FORMAT_R8_UNORM, 1, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg8unorm", VK_FORMAT_R8G8_UNORM, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba8unorm", VK_FORMAT_R8G8B8A8_UNORM, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba8unorm-srgb", VK_FORMAT_R8G8B8A8_SRGB, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"bgra8unorm", VK_FORMAT_B8G8R8A8_UNORM, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"bgra8unorm-srgb", VK_FORMAT_B8G8R8A8_SRGB, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgb10a2unorm", VK_FORMAT_A2B10G10R10_UNORM_PACK32, 4,
     VK_IMAGE_ASPECT_COLOR_BIT},
    {"r16float", VK_FORMAT_R16_SFLOAT, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg16float", VK_FORMAT_R16G16_SFLOAT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba16float", VK_FORMAT_R16G16B16A16_SFLOAT, 8,
     VK_IMAGE_ASPECT_COLOR_BIT},
    {"r32float", VK_FORMAT_R32_SFLOAT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg32float", VK_FORMAT_R32G32_SFLOAT, 8, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba32float", VK_FORMAT_R32G32B32A32_SFLOAT, 16,
     VK_IMAGE_ASPECT_COLOR_BIT},
    {"r8uint", VK_FORMAT_R8_UINT, 1, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg8uint", VK_FORMAT_R8G8_UINT, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba8uint", VK_FORMAT_R8G8B8A8_UINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"r16uint", VK_FORMAT_R16_UINT, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg16uint", VK_FORMAT_R16G16_UINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba16uint", VK_FORMAT_R16G16B16A16_UINT, 8, VK_IMAGE_ASPECT_COLOR_BIT},
    {"r32uint", VK_FORMAT_R32_UINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg32uint", VK_FORMAT_R32G32_UINT, 8, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba32uint", VK_FORMAT_R32G32B32A32_UINT, 16, VK_IMAGE_ASPECT_COLOR_BIT},
    {"r8sint", VK_FORMAT_R8_SINT, 1, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg8sint", VK_FORMAT_R8G8_SINT, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba8sint", VK_FORMAT_R8G8B8A8_SINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"r16sint", VK_FORMAT_R16_SINT, 2, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg16sint", VK_FORMAT_R16G16_SINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba16sint", VK_FORMAT_R16G16B16A16_SINT, 8, VK_IMAGE_ASPECT_COLOR_BIT},
    {"r32sint", VK_FORMAT_R32_SINT, 4, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rg32sint", VK_FORMAT_R32G32_SINT, 8, VK_IMAGE_ASPECT_COLOR_BIT},
    {"rgba32sint", VK_FORMAT_R32G32B32A32_SINT, 16, VK_IMAGE_ASPECT_COLOR_BIT},
    {"depth16unorm", VK_FORMAT_D16_UNORM, 2, VK_IMAGE_ASPECT_DEPTH_BIT},
    {"depth24plus", VK_FORMAT_D32_SFLOAT, 4, VK_IMAGE_ASPECT_DEPTH_BIT},
    {"depth32float", VK_FORMAT_D32_SFLOAT, 4, VK_IMAGE_ASPECT_DEPTH_BIT},
    {"depth24plus-stencil8", VK_FORMAT_D32_SFLOAT_S8_UINT, 8,
     VK_IMAGE_ASPECT_DEPTH_BIT | VK_IMAGE_ASPECT_STENCIL_BIT},
    // Compressed formats, by blocks of 4 × 4 pixels, where the device has
    // them (fdw_vk_format_supported).
    {"bc1-rgba-unorm", VK_FORMAT_BC1_RGBA_UNORM_BLOCK, 8,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc1-rgba-unorm-srgb", VK_FORMAT_BC1_RGBA_SRGB_BLOCK, 8,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc3-rgba-unorm", VK_FORMAT_BC3_UNORM_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc3-rgba-unorm-srgb", VK_FORMAT_BC3_SRGB_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc4-r-unorm", VK_FORMAT_BC4_UNORM_BLOCK, 8, VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc5-rg-unorm", VK_FORMAT_BC5_UNORM_BLOCK, 16, VK_IMAGE_ASPECT_COLOR_BIT,
     4},
    {"bc6h-rgb-ufloat", VK_FORMAT_BC6H_UFLOAT_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc7-rgba-unorm", VK_FORMAT_BC7_UNORM_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"bc7-rgba-unorm-srgb", VK_FORMAT_BC7_SRGB_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"etc2-rgb8unorm", VK_FORMAT_ETC2_R8G8B8_UNORM_BLOCK, 8,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"etc2-rgb8unorm-srgb", VK_FORMAT_ETC2_R8G8B8_SRGB_BLOCK, 8,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"etc2-rgba8unorm", VK_FORMAT_ETC2_R8G8B8A8_UNORM_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"etc2-rgba8unorm-srgb", VK_FORMAT_ETC2_R8G8B8A8_SRGB_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"eac-r11unorm", VK_FORMAT_EAC_R11_UNORM_BLOCK, 8,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"eac-rg11unorm", VK_FORMAT_EAC_R11G11_UNORM_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"astc-4x4-unorm", VK_FORMAT_ASTC_4x4_UNORM_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
    {"astc-4x4-unorm-srgb", VK_FORMAT_ASTC_4x4_SRGB_BLOCK, 16,
     VK_IMAGE_ASPECT_COLOR_BIT, 4},
};

VkFilter filter(const char *name) {
  return name && std::strcmp(name, "nearest") == 0 ? VK_FILTER_NEAREST
                                                   : VK_FILTER_LINEAR;
}

VkSamplerAddressMode addressMode(const char *name) {
  if (name && std::strcmp(name, "clamp-to-edge") == 0) {
    return VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE;
  }
  if (name && std::strcmp(name, "mirror-repeat") == 0) {
    return VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT;
  }
  return VK_SAMPLER_ADDRESS_MODE_REPEAT;
}

bool compareOp(const char *name, VkCompareOp *op) {
  static constexpr std::pair<std::string_view, VkCompareOp> ops[] = {
      {"never", VK_COMPARE_OP_NEVER},
      {"less", VK_COMPARE_OP_LESS},
      {"equal", VK_COMPARE_OP_EQUAL},
      {"less-equal", VK_COMPARE_OP_LESS_OR_EQUAL},
      {"greater", VK_COMPARE_OP_GREATER},
      {"not-equal", VK_COMPARE_OP_NOT_EQUAL},
      {"greater-equal", VK_COMPARE_OP_GREATER_OR_EQUAL},
      {"always", VK_COMPARE_OP_ALWAYS},
  };
  for (const auto &[candidate, value] : ops) {
    if (name && candidate == name) {
      *op = value;
      return true;
    }
  }
  return false;
}

// The copy region of a whole texture: every layer, or the depth of a 3d one.
VkBufferImageCopy wholeTexture(const fdw_vk_texture *texture,
                               uint32_t layers) {
  VkBufferImageCopy region{};
  region.imageSubresource.aspectMask =
      texture->aspect & ~VK_IMAGE_ASPECT_STENCIL_BIT;
  region.imageSubresource.layerCount = texture->is3d ? 1 : layers;
  region.imageExtent = {texture->width, texture->height,
                        texture->is3d ? layers : 1};
  return region;
}

} // namespace

namespace fdw {

const FormatInfo *findFormat(const char *name) {
  for (const FormatInfo &info : formats) {
    if (name && std::string_view(info.name) == name) {
      return &info;
    }
  }
  return nullptr;
}

int generateMipmaps(fdw_vk_context *context, VkCommandBuffer commands,
                    fdw_vk_texture *texture) {
  if (texture->levels <= 1) {
    return 0;
  }
  VkFormatProperties properties;
  vkGetPhysicalDeviceFormatProperties(context->physicalDevice,
                                      texture->format, &properties);
  const VkFormatFeatureFlags features = properties.optimalTilingFeatures;
  if (texture->aspect != VK_IMAGE_ASPECT_COLOR_BIT || texture->is3d ||
      !(features & VK_FORMAT_FEATURE_BLIT_SRC_BIT) ||
      !(features & VK_FORMAT_FEATURE_BLIT_DST_BIT)) {
    return fail("The levels of this texture cannot be computed by blits");
  }
  // Without linear filtering of the format (rgba32float on some GPUs): a
  // texel of each 2 × 2 block.
  const VkFilter filter =
      (features & VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT)
          ? VK_FILTER_LINEAR
          : VK_FILTER_NEAREST;

  // A barrier on some levels of every layer, after `src`.
  auto levelBarrier = [&](uint32_t level, uint32_t count, Access src,
                          VkImageLayout oldLayout, Access dst,
                          VkImageLayout newLayout) {
    VkImageMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2};
    barrier.srcStageMask = src.stages;
    barrier.srcAccessMask = src.access;
    barrier.dstStageMask = dst.stages;
    barrier.dstAccessMask = dst.access;
    barrier.oldLayout = oldLayout;
    barrier.newLayout = newLayout;
    barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.image = texture->image;
    barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, level, count, 0,
                                texture->layers};
    return barrier;
  };
  const Access read{VK_PIPELINE_STAGE_2_BLIT_BIT,
                    VK_ACCESS_2_TRANSFER_READ_BIT};
  const Access written{VK_PIPELINE_STAGE_2_BLIT_BIT,
                       VK_ACCESS_2_TRANSFER_WRITE_BIT};
  // After the last use, in one barrier: the first level becomes the source
  // of the second one, the others destinations, their content discarded
  // (the blits overwrite them all).
  {
    const VkImageMemoryBarrier2 barriers[] = {
        levelBarrier(0, 1, texture->last, texture->layout, read,
                     VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL),
        levelBarrier(1, texture->levels - 1, texture->last,
                     VK_IMAGE_LAYOUT_UNDEFINED, written,
                     VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL)};
    VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
    dependency.imageMemoryBarrierCount = 2;
    dependency.pImageMemoryBarriers = barriers;
    vkCmdPipelineBarrier2(commands, &dependency);
  }
  // A level written becomes the source of the next one.
  auto toSource = [&](uint32_t level) {
    const VkImageMemoryBarrier2 barrier =
        levelBarrier(level, 1, written, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
                     read, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
    VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
    dependency.imageMemoryBarrierCount = 1;
    dependency.pImageMemoryBarriers = &barrier;
    vkCmdPipelineBarrier2(commands, &dependency);
  };
  int32_t width = static_cast<int32_t>(texture->width);
  int32_t height = static_cast<int32_t>(texture->height);
  for (uint32_t level = 1; level < texture->levels; level++) {
    if (level > 1) {
      toSource(level - 1);
    }
    VkImageBlit blit{};
    blit.srcSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, level - 1, 0,
                           texture->layers};
    blit.srcOffsets[1] = {width, height, 1};
    width = std::max(width / 2, 1);
    height = std::max(height / 2, 1);
    blit.dstSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, level, 0,
                           texture->layers};
    blit.dstOffsets[1] = {width, height, 1};
    vkCmdBlitImage(commands, texture->image,
                   VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, texture->image,
                   VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit, filter);
  }
  // Every level in the same layout, as the tracking needs. The next use
  // waits for the blits: their reads, and their writes.
  toSource(texture->levels - 1);
  texture->layout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
  texture->last = {VK_PIPELINE_STAGE_2_BLIT_BIT,
                   VK_ACCESS_2_TRANSFER_READ_BIT |
                       VK_ACCESS_2_TRANSFER_WRITE_BIT};
  return 0;
}

void destroyTexture(fdw_vk_context *context, fdw_vk_texture *texture) {
  if (texture->attachmentView) {
    vkDestroyImageView(context->device, texture->attachmentView, nullptr);
  }
  if (texture->view) {
    vkDestroyImageView(context->device, texture->view, nullptr);
  }
  if (!texture->external) {
    vmaDestroyImage(context->allocator, texture->image, texture->allocation);
  }
  delete texture;
}

} // namespace fdw

extern "C" {

fdw_vk_texture *fdw_vk_texture_create(fdw_vk_context *context,
                                      const fdw_vk_texture_options *options) {
  const FormatInfo *format = findFormat(options->format);
  if (!format) {
    fail(std::string("Unsupported texture format ") +
         (options->format ? options->format : "(none)"));
    return nullptr;
  }
  const std::string_view type = options->type ? options->type : "2d";
  const bool cube = type == "cube";
  const bool is3d = type == "3d";
  const uint32_t layers = cube ? 6 : std::max(options->layers, 1u);
  const uint32_t levels = std::max(options->mip_level_count, 1u);
  if (levels > 1 && (is3d || options->sample_count > 1)) {
    fail("3d and multisampled textures have a single level");
    return nullptr;
  }

  VkImageUsageFlags usage =
      VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
  if (options->usage & FDW_VK_TEXTURE_SAMPLED) {
    usage |= VK_IMAGE_USAGE_SAMPLED_BIT;
  }
  if (options->usage & FDW_VK_TEXTURE_STORAGE) {
    usage |= VK_IMAGE_USAGE_STORAGE_BIT;
  }
  if (options->usage & FDW_VK_TEXTURE_RENDER_ATTACHMENT) {
    usage |= (format->aspect & VK_IMAGE_ASPECT_DEPTH_BIT)
                 ? VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT
                 : VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
  }

  VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};
  info.flags = cube ? VK_IMAGE_CREATE_CUBE_COMPATIBLE_BIT : 0;
  info.imageType = is3d ? VK_IMAGE_TYPE_3D : VK_IMAGE_TYPE_2D;
  info.format = format->format;
  info.extent = {std::max(options->width, 1u), std::max(options->height, 1u),
                 is3d ? layers : 1};
  info.mipLevels = levels;
  info.arrayLayers = is3d ? 1 : layers;
  info.samples = static_cast<VkSampleCountFlagBits>(
      std::max(options->sample_count, 1u));
  info.tiling = VK_IMAGE_TILING_OPTIMAL;
  info.usage = usage;
  info.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
  VmaAllocationCreateInfo allocation{};
  allocation.usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE;

  auto *texture = new fdw_vk_texture();
  texture->format = format->format;
  texture->aspect = format->aspect;
  texture->width = info.extent.width;
  texture->height = info.extent.height;
  texture->layers = layers;
  texture->levels = levels;
  texture->pixelSize = format->pixelSize;
  texture->block = format->block;
  texture->samples = info.samples;
  texture->is3d = is3d;
  VkResult result = vmaCreateImage(context->allocator, &info, &allocation,
                                   &texture->image, &texture->allocation,
                                   nullptr);
  if (result != VK_SUCCESS) {
    delete texture;
    fail("vmaCreateImage", result);
    return nullptr;
  }

  VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
  view.image = texture->image;
  view.viewType = cube   ? VK_IMAGE_VIEW_TYPE_CUBE
                  : is3d ? VK_IMAGE_VIEW_TYPE_3D
                  : type == "2d-array" ? VK_IMAGE_VIEW_TYPE_2D_ARRAY
                                       : VK_IMAGE_VIEW_TYPE_2D;
  view.format = format->format;
  // The shaders read the depth of a depth-stencil texture.
  view.subresourceRange = {format->aspect & ~VK_IMAGE_ASPECT_STENCIL_BIT, 0,
                           levels, 0, is3d ? 1 : layers};
  result = vkCreateImageView(context->device, &view, nullptr, &texture->view);
  if (result == VK_SUCCESS && !is3d) {
    VkImageViewCreateInfo attachment = view;
    attachment.viewType = VK_IMAGE_VIEW_TYPE_2D;
    attachment.subresourceRange = {format->aspect, 0, 1, 0, 1};
    result = vkCreateImageView(context->device, &attachment, nullptr,
                               &texture->attachmentView);
  }
  if (result != VK_SUCCESS) {
    destroyTexture(context, texture);
    fail("vkCreateImageView", result);
    return nullptr;
  }
  setName(context, VK_OBJECT_TYPE_IMAGE,
          reinterpret_cast<uint64_t>(texture->image), options->label);
  texture->id = context->nextId++;
  context->textures[texture->id] = texture;
  return texture;
}

void fdw_vk_texture_destroy(fdw_vk_context *context, fdw_vk_texture *texture) {
  // The images of the swapchains belong to them.
  if (!texture || texture->external ||
      !context->textures.erase(texture->id)) {
    return;
  }
  defer(context, [context, texture] { destroyTexture(context, texture); });
}

uint32_t fdw_vk_texture_id(const fdw_vk_texture *texture) {
  return texture->id;
}

uint32_t fdw_vk_texture_pixel_size(const fdw_vk_texture *texture) {
  return texture->pixelSize;
}

int fdw_vk_texture_write(fdw_vk_context *context, fdw_vk_texture *texture,
                         const void *data, uint64_t size) {
  return fdw_vk_texture_write_level(context, texture, 0, 0, texture->layers,
                                    data, size);
}

int fdw_vk_texture_write_level(fdw_vk_context *context,
                               fdw_vk_texture *texture, uint32_t level,
                               uint32_t layer, uint32_t layer_count,
                               const void *data, uint64_t size) {
  if (level >= texture->levels) {
    return fail("The texture has no level " + std::to_string(level));
  }
  if (layer_count == 0 || layer >= texture->layers ||
      layer_count > texture->layers - layer) {
    return fail("The layers written are not inside the texture");
  }
  const uint32_t width = std::max(texture->width >> level, 1u);
  const uint32_t height = std::max(texture->height >> level, 1u);
  // Rows of blocks for the compressed formats, the last ones partly
  // outside of the level.
  const uint64_t columns = (width + texture->block - 1) / texture->block;
  const uint64_t rows = (height + texture->block - 1) / texture->block;
  const uint64_t expected = columns * rows * layer_count * texture->pixelSize;
  if (size != expected) {
    return fail("The level takes " + std::to_string(expected) +
                " bytes, not " + std::to_string(size));
  }
  HostBuffer staging;
  if (createHostBuffer(context, size, false, &staging) != 0) {
    return -1;
  }
  std::memcpy(staging.mapped, data, size);
  vmaFlushAllocation(context->allocator, staging.allocation, 0, size);

  VkCommandBuffer commands = transfers(context);
  // When the whole texture is written, its content can be discarded; the
  // other levels and layers are kept otherwise.
  const bool whole = texture->levels == 1 && layer_count == texture->layers;
  useTexture(commands, texture, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
             VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT,
             whole);
  // Tightly packed rows (bufferRowLength 0), of blocks for the compressed
  // formats; the extent of the level, which ends at its edges.
  VkBufferImageCopy region = wholeTexture(texture, layer_count);
  region.imageSubresource.mipLevel = level;
  region.imageSubresource.baseArrayLayer = texture->is3d ? 0 : layer;
  region.imageOffset = {0, 0, texture->is3d ? static_cast<int32_t>(layer) : 0};
  region.imageExtent = {width, height, texture->is3d ? layer_count : 1};
  vkCmdCopyBufferToImage(commands, staging.buffer, texture->image,
                         VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
  VmaAllocator allocator = context->allocator;
  defer(context, [allocator, staging] {
    vmaDestroyBuffer(allocator, staging.buffer, staging.allocation);
  });
  return 0;
}

int fdw_vk_texture_generate_mipmaps(fdw_vk_context *context,
                                    fdw_vk_texture *texture) {
  return generateMipmaps(context, transfers(context), texture);
}

int fdw_vk_texture_read(fdw_vk_context *context, fdw_vk_texture *texture,
                        uint32_t x, uint32_t y, uint32_t width,
                        uint32_t height, uint64_t *ticket) {
  if (texture->samples != VK_SAMPLE_COUNT_1_BIT) {
    return fail("A multisampled texture cannot be read back: resolve it");
  }
  if (width == 0 || height == 0 || x > texture->width ||
      y > texture->height || width > texture->width - x ||
      height > texture->height - y) {
    return fail("The region read is not inside the texture");
  }
  const uint64_t size =
      static_cast<uint64_t>(width) * height * texture->pixelSize;
  HostBuffer readback;
  if (createHostBuffer(context, size, true, &readback) != 0) {
    return -1;
  }
  VkCommandBuffer commands = transfers(context);
  useTexture(commands, texture, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
             VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_READ_BIT);
  VkBufferImageCopy region = wholeTexture(texture, 1);
  region.imageOffset = {static_cast<int32_t>(x), static_cast<int32_t>(y), 0};
  region.imageExtent = {width, height, 1};
  vkCmdCopyImageToBuffer(commands, texture->image,
                         VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, readback.buffer,
                         1, &region);
  // The CPU reads the copy once the submission is done.
  memoryBarrier(commands, VK_PIPELINE_STAGE_2_COPY_BIT,
                VK_ACCESS_2_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_2_HOST_BIT,
                VK_ACCESS_2_HOST_READ_BIT);
  const uint64_t submission = submit(context, {});
  if (submission == 0) {
    vmaDestroyBuffer(context->allocator, readback.buffer, readback.allocation);
    return -1;
  }
  *ticket = addRead(context, submission, readback, size);
  return 0;
}

fdw_vk_sampler *fdw_vk_sampler_create(fdw_vk_context *context,
                                      const fdw_vk_sampler_options *options) {
  VkSamplerCreateInfo info{VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO};
  info.minFilter = filter(options->min_filter);
  info.magFilter = filter(options->mag_filter);
  info.mipmapMode = filter(options->mipmap_filter) == VK_FILTER_NEAREST
                        ? VK_SAMPLER_MIPMAP_MODE_NEAREST
                        : VK_SAMPLER_MIPMAP_MODE_LINEAR;
  info.addressModeU = addressMode(options->wrap_u);
  info.addressModeV = addressMode(options->wrap_v);
  info.addressModeW = addressMode(options->wrap_w);
  // Enabled with the feature only: maxAnisotropy is 1 without it.
  if (options->max_anisotropy > 1 && context->maxAnisotropy > 1) {
    info.anisotropyEnable = VK_TRUE;
    info.maxAnisotropy =
        std::min(options->max_anisotropy, context->maxAnisotropy);
  }
  VkCompareOp op;
  if (compareOp(options->compare, &op)) {
    info.compareEnable = VK_TRUE;
    info.compareOp = op;
  }
  info.maxLod = VK_LOD_CLAMP_NONE;
  auto *sampler = new fdw_vk_sampler();
  const VkResult result =
      vkCreateSampler(context->device, &info, nullptr, &sampler->sampler);
  if (result != VK_SUCCESS) {
    delete sampler;
    fail("vkCreateSampler", result);
    return nullptr;
  }
  setName(context, VK_OBJECT_TYPE_SAMPLER,
          reinterpret_cast<uint64_t>(sampler->sampler), options->label);
  sampler->id = context->nextId++;
  context->samplers[sampler->id] = sampler;
  return sampler;
}

void fdw_vk_sampler_destroy(fdw_vk_context *context, fdw_vk_sampler *sampler) {
  if (!sampler || !context->samplers.erase(sampler->id)) {
    return;
  }
  VkDevice device = context->device;
  defer(context, [device, sampler] {
    vkDestroySampler(device, sampler->sampler, nullptr);
    delete sampler;
  });
}

float fdw_vk_max_anisotropy(const fdw_vk_context *context) {
  return context->maxAnisotropy;
}

uint32_t fdw_vk_max_color_attachments(const fdw_vk_context *context) {
  return context->maxColorAttachments;
}

int32_t fdw_vk_independent_blend(const fdw_vk_context *context) {
  return context->independentBlend ? 1 : 0;
}

int32_t fdw_vk_format_supported(const fdw_vk_context *context,
                                const char *name) {
  const FormatInfo *format = findFormat(name);
  if (!format) {
    return 0;
  }
  VkFormatProperties properties;
  vkGetPhysicalDeviceFormatProperties(context->physicalDevice, format->format,
                                      &properties);
  const VkFormatFeatureFlags needed =
      VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
  return (properties.optimalTilingFeatures & needed) == needed ? 1 : 0;
}

uint32_t fdw_vk_sampler_id(const fdw_vk_sampler *sampler) {
  return sampler->id;
}

} // extern "C"
