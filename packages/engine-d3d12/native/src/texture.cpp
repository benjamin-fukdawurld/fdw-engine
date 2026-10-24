// Textures and samplers.

#include "context.hpp"

#include <algorithm>
#include <cstring>
#include <string_view>

using namespace fdw;

namespace {

// The formats of the engine (GpuTextureFormat). depth24plus is a 32-bit
// float depth, as on Vulkan. Depth textures are typeless, viewed as depth
// by the passes and as floats by the shaders.
constexpr FormatInfo formats[] = {
    {"r8unorm", DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8_UNORM,
     DXGI_FORMAT_R8_UNORM, 1},
    {"rg8unorm", DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8G8_UNORM,
     DXGI_FORMAT_R8G8_UNORM, 2},
    {"rgba8unorm", DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
     DXGI_FORMAT_R8G8B8A8_UNORM, 4},
    {"rgba8unorm-srgb", DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
     DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, 4},
    {"bgra8unorm", DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM,
     DXGI_FORMAT_B8G8R8A8_UNORM, 4},
    {"bgra8unorm-srgb", DXGI_FORMAT_B8G8R8A8_UNORM_SRGB,
     DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, 4},
    {"rgb10a2unorm", DXGI_FORMAT_R10G10B10A2_UNORM,
     DXGI_FORMAT_R10G10B10A2_UNORM, DXGI_FORMAT_R10G10B10A2_UNORM, 4},
    {"r16float", DXGI_FORMAT_R16_FLOAT, DXGI_FORMAT_R16_FLOAT,
     DXGI_FORMAT_R16_FLOAT, 2},
    {"rg16float", DXGI_FORMAT_R16G16_FLOAT, DXGI_FORMAT_R16G16_FLOAT,
     DXGI_FORMAT_R16G16_FLOAT, 4},
    {"rgba16float", DXGI_FORMAT_R16G16B16A16_FLOAT,
     DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R16G16B16A16_FLOAT, 8},
    {"r32float", DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R32_FLOAT,
     DXGI_FORMAT_R32_FLOAT, 4},
    {"rg32float", DXGI_FORMAT_R32G32_FLOAT, DXGI_FORMAT_R32G32_FLOAT,
     DXGI_FORMAT_R32G32_FLOAT, 8},
    {"rgba32float", DXGI_FORMAT_R32G32B32A32_FLOAT,
     DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_FORMAT_R32G32B32A32_FLOAT, 16},
    {"r8uint", DXGI_FORMAT_R8_UINT, DXGI_FORMAT_R8_UINT, DXGI_FORMAT_R8_UINT,
     1},
    {"rg8uint", DXGI_FORMAT_R8G8_UINT, DXGI_FORMAT_R8G8_UINT,
     DXGI_FORMAT_R8G8_UINT, 2},
    {"rgba8uint", DXGI_FORMAT_R8G8B8A8_UINT, DXGI_FORMAT_R8G8B8A8_UINT,
     DXGI_FORMAT_R8G8B8A8_UINT, 4},
    {"r16uint", DXGI_FORMAT_R16_UINT, DXGI_FORMAT_R16_UINT,
     DXGI_FORMAT_R16_UINT, 2},
    {"rg16uint", DXGI_FORMAT_R16G16_UINT, DXGI_FORMAT_R16G16_UINT,
     DXGI_FORMAT_R16G16_UINT, 4},
    {"rgba16uint", DXGI_FORMAT_R16G16B16A16_UINT,
     DXGI_FORMAT_R16G16B16A16_UINT, DXGI_FORMAT_R16G16B16A16_UINT, 8},
    {"r32uint", DXGI_FORMAT_R32_UINT, DXGI_FORMAT_R32_UINT,
     DXGI_FORMAT_R32_UINT, 4},
    {"rg32uint", DXGI_FORMAT_R32G32_UINT, DXGI_FORMAT_R32G32_UINT,
     DXGI_FORMAT_R32G32_UINT, 8},
    {"rgba32uint", DXGI_FORMAT_R32G32B32A32_UINT,
     DXGI_FORMAT_R32G32B32A32_UINT, DXGI_FORMAT_R32G32B32A32_UINT, 16},
    {"r8sint", DXGI_FORMAT_R8_SINT, DXGI_FORMAT_R8_SINT, DXGI_FORMAT_R8_SINT,
     1},
    {"rg8sint", DXGI_FORMAT_R8G8_SINT, DXGI_FORMAT_R8G8_SINT,
     DXGI_FORMAT_R8G8_SINT, 2},
    {"rgba8sint", DXGI_FORMAT_R8G8B8A8_SINT, DXGI_FORMAT_R8G8B8A8_SINT,
     DXGI_FORMAT_R8G8B8A8_SINT, 4},
    {"r16sint", DXGI_FORMAT_R16_SINT, DXGI_FORMAT_R16_SINT,
     DXGI_FORMAT_R16_SINT, 2},
    {"rg16sint", DXGI_FORMAT_R16G16_SINT, DXGI_FORMAT_R16G16_SINT,
     DXGI_FORMAT_R16G16_SINT, 4},
    {"rgba16sint", DXGI_FORMAT_R16G16B16A16_SINT,
     DXGI_FORMAT_R16G16B16A16_SINT, DXGI_FORMAT_R16G16B16A16_SINT, 8},
    {"r32sint", DXGI_FORMAT_R32_SINT, DXGI_FORMAT_R32_SINT,
     DXGI_FORMAT_R32_SINT, 4},
    {"rg32sint", DXGI_FORMAT_R32G32_SINT, DXGI_FORMAT_R32G32_SINT,
     DXGI_FORMAT_R32G32_SINT, 8},
    {"rgba32sint", DXGI_FORMAT_R32G32B32A32_SINT,
     DXGI_FORMAT_R32G32B32A32_SINT, DXGI_FORMAT_R32G32B32A32_SINT, 16},
    {"depth16unorm", DXGI_FORMAT_R16_TYPELESS, DXGI_FORMAT_R16_UNORM,
     DXGI_FORMAT_D16_UNORM, 2, true},
    {"depth24plus", DXGI_FORMAT_R32_TYPELESS, DXGI_FORMAT_R32_FLOAT,
     DXGI_FORMAT_D32_FLOAT, 4, true},
    {"depth32float", DXGI_FORMAT_R32_TYPELESS, DXGI_FORMAT_R32_FLOAT,
     DXGI_FORMAT_D32_FLOAT, 4, true},
    {"depth24plus-stencil8", DXGI_FORMAT_R32G8X24_TYPELESS,
     DXGI_FORMAT_R32_FLOAT_X8X24_TYPELESS, DXGI_FORMAT_D32_FLOAT_S8X24_UINT, 8,
     true, true},
    // Compressed formats, by blocks of 4 × 4 pixels. Direct3D has neither
    // ETC2 nor ASTC.
    {"bc1-rgba-unorm", DXGI_FORMAT_BC1_UNORM, DXGI_FORMAT_BC1_UNORM,
     DXGI_FORMAT_UNKNOWN, 8, false, false, 4},
    {"bc1-rgba-unorm-srgb", DXGI_FORMAT_BC1_UNORM_SRGB,
     DXGI_FORMAT_BC1_UNORM_SRGB, DXGI_FORMAT_UNKNOWN, 8, false, false, 4},
    {"bc3-rgba-unorm", DXGI_FORMAT_BC3_UNORM, DXGI_FORMAT_BC3_UNORM,
     DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
    {"bc3-rgba-unorm-srgb", DXGI_FORMAT_BC3_UNORM_SRGB,
     DXGI_FORMAT_BC3_UNORM_SRGB, DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
    {"bc4-r-unorm", DXGI_FORMAT_BC4_UNORM, DXGI_FORMAT_BC4_UNORM,
     DXGI_FORMAT_UNKNOWN, 8, false, false, 4},
    {"bc5-rg-unorm", DXGI_FORMAT_BC5_UNORM, DXGI_FORMAT_BC5_UNORM,
     DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
    {"bc6h-rgb-ufloat", DXGI_FORMAT_BC6H_UF16, DXGI_FORMAT_BC6H_UF16,
     DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
    {"bc7-rgba-unorm", DXGI_FORMAT_BC7_UNORM, DXGI_FORMAT_BC7_UNORM,
     DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
    {"bc7-rgba-unorm-srgb", DXGI_FORMAT_BC7_UNORM_SRGB,
     DXGI_FORMAT_BC7_UNORM_SRGB, DXGI_FORMAT_UNKNOWN, 16, false, false, 4},
};

D3D12_FILTER_TYPE filterType(const char *name) {
  return name && std::strcmp(name, "nearest") == 0 ? D3D12_FILTER_TYPE_POINT
                                                   : D3D12_FILTER_TYPE_LINEAR;
}

D3D12_TEXTURE_ADDRESS_MODE addressMode(const char *name) {
  if (name && std::strcmp(name, "clamp-to-edge") == 0) {
    return D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
  }
  if (name && std::strcmp(name, "mirror-repeat") == 0) {
    return D3D12_TEXTURE_ADDRESS_MODE_MIRROR;
  }
  return D3D12_TEXTURE_ADDRESS_MODE_WRAP;
}

bool compareFunction(const char *name, D3D12_COMPARISON_FUNC *function) {
  static constexpr std::pair<std::string_view, D3D12_COMPARISON_FUNC> ops[] = {
      {"never", D3D12_COMPARISON_FUNC_NEVER},
      {"less", D3D12_COMPARISON_FUNC_LESS},
      {"equal", D3D12_COMPARISON_FUNC_EQUAL},
      {"less-equal", D3D12_COMPARISON_FUNC_LESS_EQUAL},
      {"greater", D3D12_COMPARISON_FUNC_GREATER},
      {"not-equal", D3D12_COMPARISON_FUNC_NOT_EQUAL},
      {"greater-equal", D3D12_COMPARISON_FUNC_GREATER_EQUAL},
      {"always", D3D12_COMPARISON_FUNC_ALWAYS},
  };
  for (const auto &[candidate, value] : ops) {
    if (name && candidate == name) {
      *function = value;
      return true;
    }
  }
  return false;
}

// The render target or depth view of the first level of the first layer,
// as the passes draw into it.
int createAttachmentView(fdw_dx_context *context, fdw_dx_texture *texture) {
  ID3D12Resource *resource = texture->resource.Get();
  const bool layered = texture->layers > 1 || texture->type == "cube";
  const bool multisampled = texture->samples > 1;
  if (texture->format->depth) {
    texture->dsv = context->dsvs.allocate(1);
    if (texture->dsv < 0) {
      return fail("Too many depth targets");
    }
    D3D12_DEPTH_STENCIL_VIEW_DESC view{};
    view.Format = texture->format->target;
    if (multisampled) {
      view.ViewDimension = layered ? D3D12_DSV_DIMENSION_TEXTURE2DMSARRAY
                                   : D3D12_DSV_DIMENSION_TEXTURE2DMS;
      view.Texture2DMSArray.ArraySize = 1;
    } else if (layered) {
      view.ViewDimension = D3D12_DSV_DIMENSION_TEXTURE2DARRAY;
      view.Texture2DArray.ArraySize = 1;
    } else {
      view.ViewDimension = D3D12_DSV_DIMENSION_TEXTURE2D;
    }
    context->device->CreateDepthStencilView(
        resource, &view, context->dsvs.cpu(static_cast<uint32_t>(texture->dsv)));
    return 0;
  }
  texture->rtv = context->rtvs.allocate(1);
  if (texture->rtv < 0) {
    return fail("Too many render targets");
  }
  D3D12_RENDER_TARGET_VIEW_DESC view{};
  view.Format = texture->format->target;
  if (multisampled) {
    view.ViewDimension = layered ? D3D12_RTV_DIMENSION_TEXTURE2DMSARRAY
                                 : D3D12_RTV_DIMENSION_TEXTURE2DMS;
    view.Texture2DMSArray.ArraySize = 1;
  } else if (layered) {
    view.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2DARRAY;
    view.Texture2DArray.ArraySize = 1;
  } else {
    view.ViewDimension = D3D12_RTV_DIMENSION_TEXTURE2D;
  }
  context->device->CreateRenderTargetView(
      resource, &view, context->rtvs.cpu(static_cast<uint32_t>(texture->rtv)));
  return 0;
}

uint32_t subresource(const fdw_dx_texture *texture, uint32_t level,
                     uint32_t layer) {
  return level + layer * texture->levels;
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

void destroyTexture(fdw_dx_context *context, fdw_dx_texture *texture) {
  if (texture->rtv >= 0) {
    context->rtvs.release(static_cast<uint32_t>(texture->rtv), 1);
  }
  if (texture->dsv >= 0) {
    context->dsvs.release(static_cast<uint32_t>(texture->dsv), 1);
  }
  delete texture;
}

fdw_dx_texture *wrapTexture(fdw_dx_context *context,
                            ComPtr<ID3D12Resource> resource,
                            const char *format, D3D12_RESOURCE_STATES state) {
  const D3D12_RESOURCE_DESC desc = resource->GetDesc();
  auto *texture = new fdw_dx_texture();
  texture->resource = std::move(resource);
  texture->format = findFormat(format);
  texture->width = static_cast<uint32_t>(desc.Width);
  texture->height = desc.Height;
  texture->external = true;
  texture->state = state;
  if (!texture->format || createAttachmentView(context, texture) != 0) {
    destroyTexture(context, texture);
    return nullptr;
  }
  texture->id = context->nextId++;
  context->textures[texture->id] = texture;
  return texture;
}

} // namespace fdw

extern "C" {

fdw_dx_texture *fdw_dx_texture_create(fdw_dx_context *context,
                                      const fdw_dx_texture_options *options) {
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
  const uint32_t samples = std::max(options->sample_count, 1u);
  if (levels > 1 && (is3d || samples > 1)) {
    fail("3d and multisampled textures have a single level");
    return nullptr;
  }

  D3D12_RESOURCE_DESC desc{};
  desc.Dimension = is3d ? D3D12_RESOURCE_DIMENSION_TEXTURE3D
                        : D3D12_RESOURCE_DIMENSION_TEXTURE2D;
  desc.Width = std::max(options->width, 1u);
  desc.Height = std::max(options->height, 1u);
  desc.DepthOrArraySize = static_cast<UINT16>(layers);
  desc.MipLevels = static_cast<UINT16>(levels);
  desc.Format = format->resource;
  desc.SampleDesc.Count = samples;
  desc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
  const bool attachment =
      (options->usage & FDW_DX_TEXTURE_RENDER_ATTACHMENT) != 0;
  D3D12_RESOURCE_STATES state = D3D12_RESOURCE_STATE_COMMON;
  if (format->depth) {
    if (attachment) {
      desc.Flags |= D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
      state = D3D12_RESOURCE_STATE_DEPTH_WRITE;
    }
  } else if (format->block == 1 && (attachment || levels > 1)) {
    // The levels of detail are drawn from the previous ones.
    desc.Flags |= D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
  }
  if (options->usage & FDW_DX_TEXTURE_STORAGE) {
    desc.Flags |= D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
  }

  auto *texture = new fdw_dx_texture();
  texture->format = format;
  texture->type = std::string(type);
  texture->width = static_cast<uint32_t>(desc.Width);
  texture->height = desc.Height;
  texture->layers = layers;
  texture->levels = levels;
  texture->samples = samples;
  texture->is3d = is3d;
  texture->state = state;
  D3D12_HEAP_PROPERTIES properties{D3D12_HEAP_TYPE_DEFAULT};
  const HRESULT result = context->device->CreateCommittedResource(
      &properties, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr,
      IID_PPV_ARGS(&texture->resource));
  if (FAILED(result)) {
    delete texture;
    fail("CreateCommittedResource (texture)", result);
    return nullptr;
  }
  if (attachment && !is3d && createAttachmentView(context, texture) != 0) {
    destroyTexture(context, texture);
    return nullptr;
  }
  setName(texture->resource.Get(), options->label);
  texture->id = context->nextId++;
  context->textures[texture->id] = texture;
  return texture;
}

void fdw_dx_texture_destroy(fdw_dx_context *context, fdw_dx_texture *texture) {
  // The images of the swapchains belong to them.
  if (!texture || texture->external ||
      !context->textures.erase(texture->id)) {
    return;
  }
  defer(context, [context, texture] { destroyTexture(context, texture); });
}

uint32_t fdw_dx_texture_id(const fdw_dx_texture *texture) {
  return texture->id;
}

uint32_t fdw_dx_texture_pixel_size(const fdw_dx_texture *texture) {
  return texture->format->pixelSize;
}

int fdw_dx_texture_write(fdw_dx_context *context, fdw_dx_texture *texture,
                         const void *data, uint64_t size) {
  return fdw_dx_texture_write_level(context, texture, 0, 0, texture->layers,
                                    data, size);
}

int fdw_dx_texture_write_level(fdw_dx_context *context,
                               fdw_dx_texture *texture, uint32_t level,
                               uint32_t layer, uint32_t layer_count,
                               const void *data, uint64_t size) {
  if (level >= texture->levels) {
    return fail("The texture has no level " + std::to_string(level));
  }
  if (layer_count == 0 || layer >= texture->layers ||
      layer_count > texture->layers - layer) {
    return fail("The layers written are not inside the texture");
  }
  const FormatInfo *format = texture->format;
  const uint32_t block = format->block;
  const uint32_t width = std::max(texture->width >> level, 1u);
  const uint32_t height = std::max(texture->height >> level, 1u);
  // Rows of blocks for the compressed formats, the last ones partly
  // outside of the level.
  const uint32_t columns = (width + block - 1) / block;
  const uint32_t rows = (height + block - 1) / block;
  const uint64_t rowSize = static_cast<uint64_t>(columns) * format->pixelSize;
  const uint64_t layerSize = rowSize * rows;
  if (size != layerSize * layer_count) {
    return fail("The level takes " + std::to_string(layerSize * layer_count) +
                " bytes, not " + std::to_string(size));
  }
  ID3D12GraphicsCommandList *list = transfers(context);
  if (!list) {
    return -1;
  }
  useTexture(context, list, texture, D3D12_RESOURCE_STATE_COPY_DEST);
  // Rows 256 bytes apart; whole blocks (a level of 2 × 2 pixels is copied
  // from a block of 4 × 4).
  const uint64_t pitch = (rowSize + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1) &
                         ~uint64_t(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
  D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint{};
  footprint.Footprint.Format = format->resource;
  footprint.Footprint.Width = columns * block;
  footprint.Footprint.Height = rows * block;
  footprint.Footprint.Depth = 1;
  footprint.Footprint.RowPitch = static_cast<UINT>(pitch);
  // A 3d texture: the slices [layer, layer + layer_count) of its level, in
  // one copy.
  const uint32_t copies = texture->is3d ? 1 : layer_count;
  const uint32_t slices = texture->is3d ? layer_count : 1;
  footprint.Footprint.Depth = slices;
  const auto *source = static_cast<const uint8_t *>(data);
  for (uint32_t copy = 0; copy < copies; copy++) {
    Upload staging;
    if (upload(context, pitch * rows * slices,
               D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT, &staging) != 0) {
      return -1;
    }
    for (uint32_t row = 0; row < rows * slices; row++) {
      std::memcpy(staging.data + row * pitch, source + row * rowSize, rowSize);
    }
    source += layerSize * slices;
    footprint.Offset = staging.offset;
    D3D12_TEXTURE_COPY_LOCATION from{staging.resource,
                                     D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
    from.PlacedFootprint = footprint;
    D3D12_TEXTURE_COPY_LOCATION to{texture->resource.Get(),
                                   D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
    to.SubresourceIndex =
        subresource(texture, level, texture->is3d ? 0 : layer + copy);
    list->CopyTextureRegion(&to, 0, 0, texture->is3d ? layer : 0, &from,
                            nullptr);
  }
  return 0;
}

int fdw_dx_texture_generate_mipmaps(fdw_dx_context *context,
                                    fdw_dx_texture *texture) {
  ID3D12GraphicsCommandList *list = transfers(context);
  return list ? generateMipmaps(context, list, texture) : -1;
}

int fdw_dx_texture_read(fdw_dx_context *context, fdw_dx_texture *texture,
                        uint32_t x, uint32_t y, uint32_t width,
                        uint32_t height, uint64_t *ticket) {
  if (texture->samples != 1) {
    return fail("A multisampled texture cannot be read back: resolve it");
  }
  if (width == 0 || height == 0 || x > texture->width ||
      y > texture->height || width > texture->width - x ||
      height > texture->height - y) {
    return fail("The region read is not inside the texture");
  }
  const uint32_t pixelSize = texture->format->pixelSize;
  // Depth textures are copied whole; the region is taken from the copy.
  const bool whole = texture->format->depth;
  const uint32_t copyWidth = whole ? texture->width : width;
  const uint32_t copyHeight = whole ? texture->height : height;
  const uint64_t pitch =
      (static_cast<uint64_t>(copyWidth) * pixelSize +
       D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1) &
      ~uint64_t(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
  PendingRead read;
  if (createBuffer(context, pitch * copyHeight, D3D12_HEAP_TYPE_READBACK,
                   D3D12_RESOURCE_STATE_COPY_DEST, &read.readback) != 0) {
    return -1;
  }
  ID3D12GraphicsCommandList *list = transfers(context);
  if (!list) {
    return -1;
  }
  useTexture(context, list, texture, D3D12_RESOURCE_STATE_COPY_SOURCE);
  D3D12_TEXTURE_COPY_LOCATION to{read.readback.Get(),
                                 D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT};
  to.PlacedFootprint.Footprint = {texture->format->resource, copyWidth,
                                  copyHeight, 1, static_cast<UINT>(pitch)};
  D3D12_TEXTURE_COPY_LOCATION from{texture->resource.Get(),
                                   D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
  from.SubresourceIndex = 0;
  const D3D12_BOX box{x, y, 0, x + width, y + height, 1};
  list->CopyTextureRegion(&to, 0, 0, 0, &from, whole ? nullptr : &box);
  read.submission = submit(context);
  if (read.submission == 0) {
    return -1;
  }
  read.pitch = pitch;
  read.rowSize = static_cast<uint64_t>(width) * pixelSize;
  read.rows = height;
  read.offset = whole ? y * pitch + static_cast<uint64_t>(x) * pixelSize : 0;
  *ticket = addRead(context, std::move(read));
  return 0;
}

fdw_dx_sampler *fdw_dx_sampler_create(fdw_dx_context *context,
                                      const fdw_dx_sampler_options *options) {
  D3D12_SAMPLER_DESC desc{};
  const D3D12_FILTER_TYPE min = filterType(options->min_filter);
  const D3D12_FILTER_TYPE mag = filterType(options->mag_filter);
  const D3D12_FILTER_TYPE mip = filterType(options->mipmap_filter);
  D3D12_COMPARISON_FUNC function = D3D12_COMPARISON_FUNC_NEVER;
  const bool comparison = compareFunction(options->compare, &function);
  const D3D12_FILTER_REDUCTION_TYPE reduction =
      comparison ? D3D12_FILTER_REDUCTION_TYPE_COMPARISON
                 : D3D12_FILTER_REDUCTION_TYPE_STANDARD;
  // Anisotropic filtering is linear in every way.
  const bool anisotropic = options->max_anisotropy > 1 &&
                           min == D3D12_FILTER_TYPE_LINEAR &&
                           mag == D3D12_FILTER_TYPE_LINEAR &&
                           mip == D3D12_FILTER_TYPE_LINEAR;
  desc.Filter = anisotropic ? D3D12_ENCODE_ANISOTROPIC_FILTER(reduction)
                            : D3D12_ENCODE_BASIC_FILTER(min, mag, mip, reduction);
  desc.MaxAnisotropy =
      anisotropic ? static_cast<UINT>(std::min(options->max_anisotropy, 16.0f))
                  : 1;
  desc.AddressU = addressMode(options->wrap_u);
  desc.AddressV = addressMode(options->wrap_v);
  desc.AddressW = addressMode(options->wrap_w);
  desc.ComparisonFunc = function;
  desc.MinLOD = 0;
  desc.MaxLOD = D3D12_FLOAT32_MAX;
  auto *sampler = new fdw_dx_sampler();
  sampler->desc = desc;
  sampler->id = context->nextId++;
  context->samplers[sampler->id] = sampler;
  return sampler;
}

void fdw_dx_sampler_destroy(fdw_dx_context *context, fdw_dx_sampler *sampler) {
  if (!sampler || !context->samplers.erase(sampler->id)) {
    return;
  }
  // The groups copied its description: it can go now.
  delete sampler;
}

float fdw_dx_max_anisotropy(const fdw_dx_context *) { return 16; }

uint32_t fdw_dx_max_color_attachments(const fdw_dx_context *) {
  return D3D12_SIMULTANEOUS_RENDER_TARGET_COUNT;
}

int32_t fdw_dx_independent_blend(const fdw_dx_context *) { return 1; }

int32_t fdw_dx_format_supported(const fdw_dx_context *context,
                                const char *name) {
  const FormatInfo *format = findFormat(name);
  if (!format) {
    return 0;
  }
  D3D12_FEATURE_DATA_FORMAT_SUPPORT support{format->srv};
  if (FAILED(context->device->CheckFeatureSupport(
          D3D12_FEATURE_FORMAT_SUPPORT, &support, sizeof(support)))) {
    return 0;
  }
  return (support.Support1 & D3D12_FORMAT_SUPPORT1_TEXTURE2D) &&
                 (support.Support1 & D3D12_FORMAT_SUPPORT1_SHADER_SAMPLE)
             ? 1
             : 0;
}

uint32_t fdw_dx_sampler_id(const fdw_dx_sampler *sampler) {
  return sampler->id;
}

} // extern "C"
