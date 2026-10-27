// Groups of resources (descriptors in the shader visible heaps), their
// layouts, the root signatures, and the pipelines.

#include "context.hpp"

#include "fdw/d3d12.h"

#include <algorithm>
#include <cstring>
#include <string_view>

using namespace fdw;

namespace {

// The register space of the root constants (D3D12ConstantsSpace of the
// HLSL generator): the first instance of a draw, the workgroups of a
// dispatch.
constexpr UINT ConstantsSpace = 100;
constexpr UINT ConstantCount = 3;

D3D12_DESCRIPTOR_RANGE_TYPE rangeType(fdw_dx_binding_kind kind) {
  switch (kind) {
  case FDW_DX_BINDING_UNIFORM:
    return D3D12_DESCRIPTOR_RANGE_TYPE_CBV;
  case FDW_DX_BINDING_SAMPLER:
    return D3D12_DESCRIPTOR_RANGE_TYPE_SAMPLER;
  case FDW_DX_BINDING_STORAGE_READ_WRITE:
    return D3D12_DESCRIPTOR_RANGE_TYPE_UAV;
  case FDW_DX_BINDING_TEXTURE:
  case FDW_DX_BINDING_STORAGE_READ:
  case FDW_DX_BINDING_ACCELERATION_STRUCTURE:
    break;
  }
  return D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
}

struct VertexFormat {
  std::string_view name;
  DXGI_FORMAT format;
};

constexpr VertexFormat vertexFormats[] = {
    {"float32", DXGI_FORMAT_R32_FLOAT},
    {"float32x2", DXGI_FORMAT_R32G32_FLOAT},
    {"float32x3", DXGI_FORMAT_R32G32B32_FLOAT},
    {"float32x4", DXGI_FORMAT_R32G32B32A32_FLOAT},
    {"float16x2", DXGI_FORMAT_R16G16_FLOAT},
    {"float16x4", DXGI_FORMAT_R16G16B16A16_FLOAT},
    {"uint32", DXGI_FORMAT_R32_UINT},
    {"uint32x2", DXGI_FORMAT_R32G32_UINT},
    {"uint32x3", DXGI_FORMAT_R32G32B32_UINT},
    {"uint32x4", DXGI_FORMAT_R32G32B32A32_UINT},
    {"sint32", DXGI_FORMAT_R32_SINT},
    {"sint32x2", DXGI_FORMAT_R32G32_SINT},
    {"sint32x3", DXGI_FORMAT_R32G32B32_SINT},
    {"sint32x4", DXGI_FORMAT_R32G32B32A32_SINT},
    {"uint8x2", DXGI_FORMAT_R8G8_UINT},
    {"uint8x4", DXGI_FORMAT_R8G8B8A8_UINT},
    {"sint8x2", DXGI_FORMAT_R8G8_SINT},
    {"sint8x4", DXGI_FORMAT_R8G8B8A8_SINT},
    {"unorm8x2", DXGI_FORMAT_R8G8_UNORM},
    {"unorm8x4", DXGI_FORMAT_R8G8B8A8_UNORM},
    {"snorm8x2", DXGI_FORMAT_R8G8_SNORM},
    {"snorm8x4", DXGI_FORMAT_R8G8B8A8_SNORM},
    {"uint16x2", DXGI_FORMAT_R16G16_UINT},
    {"uint16x4", DXGI_FORMAT_R16G16B16A16_UINT},
    {"sint16x2", DXGI_FORMAT_R16G16_SINT},
    {"sint16x4", DXGI_FORMAT_R16G16B16A16_SINT},
    {"unorm16x2", DXGI_FORMAT_R16G16_UNORM},
    {"unorm16x4", DXGI_FORMAT_R16G16B16A16_UNORM},
    {"snorm16x2", DXGI_FORMAT_R16G16_SNORM},
    {"snorm16x4", DXGI_FORMAT_R16G16B16A16_SNORM},
};

bool vertexFormat(const char *name, DXGI_FORMAT *format) {
  for (const VertexFormat &candidate : vertexFormats) {
    if (name && candidate.name == name) {
      *format = candidate.format;
      return true;
    }
  }
  return false;
}

bool is(const char *value, const char *expected) {
  return value && std::strcmp(value, expected) == 0;
}

D3D12_BLEND blendFactor(const char *name) {
  if (is(name, "zero")) {
    return D3D12_BLEND_ZERO;
  }
  if (is(name, "src-alpha")) {
    return D3D12_BLEND_SRC_ALPHA;
  }
  if (is(name, "one-minus-src-alpha")) {
    return D3D12_BLEND_INV_SRC_ALPHA;
  }
  if (is(name, "dst-alpha")) {
    return D3D12_BLEND_DEST_ALPHA;
  }
  if (is(name, "one-minus-dst-alpha")) {
    return D3D12_BLEND_INV_DEST_ALPHA;
  }
  return D3D12_BLEND_ONE;
}

D3D12_BLEND_OP blendOperation(const char *name) {
  if (is(name, "subtract")) {
    return D3D12_BLEND_OP_SUBTRACT;
  }
  if (is(name, "reverse-subtract")) {
    return D3D12_BLEND_OP_REV_SUBTRACT;
  }
  if (is(name, "min")) {
    return D3D12_BLEND_OP_MIN;
  }
  if (is(name, "max")) {
    return D3D12_BLEND_OP_MAX;
  }
  return D3D12_BLEND_OP_ADD;
}

D3D12_COMPARISON_FUNC compareFunction(const char *name) {
  if (is(name, "never")) {
    return D3D12_COMPARISON_FUNC_NEVER;
  }
  if (is(name, "less")) {
    return D3D12_COMPARISON_FUNC_LESS;
  }
  if (is(name, "equal")) {
    return D3D12_COMPARISON_FUNC_EQUAL;
  }
  if (is(name, "less-equal")) {
    return D3D12_COMPARISON_FUNC_LESS_EQUAL;
  }
  if (is(name, "greater")) {
    return D3D12_COMPARISON_FUNC_GREATER;
  }
  if (is(name, "not-equal")) {
    return D3D12_COMPARISON_FUNC_NOT_EQUAL;
  }
  if (is(name, "greater-equal")) {
    return D3D12_COMPARISON_FUNC_GREATER_EQUAL;
  }
  return D3D12_COMPARISON_FUNC_ALWAYS;
}

void topology(const char *name, D3D12_PRIMITIVE_TOPOLOGY_TYPE *type,
              D3D_PRIMITIVE_TOPOLOGY *primitive) {
  if (is(name, "triangle-strip")) {
    *type = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    *primitive = D3D_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP;
  } else if (is(name, "line-list")) {
    *type = D3D12_PRIMITIVE_TOPOLOGY_TYPE_LINE;
    *primitive = D3D_PRIMITIVE_TOPOLOGY_LINELIST;
  } else if (is(name, "line-strip")) {
    *type = D3D12_PRIMITIVE_TOPOLOGY_TYPE_LINE;
    *primitive = D3D_PRIMITIVE_TOPOLOGY_LINESTRIP;
  } else if (is(name, "point-list")) {
    *type = D3D12_PRIMITIVE_TOPOLOGY_TYPE_POINT;
    *primitive = D3D_PRIMITIVE_TOPOLOGY_POINTLIST;
  } else {
    *type = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    *primitive = D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
  }
}

// Writes the descriptor of an entry of a group: `kind` from the layout.
bool writeDescriptor(fdw_dx_context *context,
                     const fdw_dx_layout_binding &binding, uint32_t object,
                     D3D12_CPU_DESCRIPTOR_HANDLE target) {
  ID3D12Device *device = context->device.Get();
  if (binding.kind == FDW_DX_BINDING_TEXTURE) {
    const auto found = context->textures.find(object);
    if (found == context->textures.end()) {
      return false;
    }
    const fdw_dx_texture *texture = found->second;
    D3D12_SHADER_RESOURCE_VIEW_DESC view{};
    view.Format = texture->format->srv;
    view.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    if (texture->samples > 1) {
      view.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2DMS;
    } else if (texture->is3d) {
      view.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE3D;
      view.Texture3D.MipLevels = texture->levels;
    } else if (texture->type == "cube") {
      view.ViewDimension = D3D12_SRV_DIMENSION_TEXTURECUBE;
      view.TextureCube.MipLevels = texture->levels;
    } else if (texture->type == "2d-array") {
      view.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2DARRAY;
      view.Texture2DArray.MipLevels = texture->levels;
      view.Texture2DArray.ArraySize = texture->layers;
    } else {
      view.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
      view.Texture2D.MipLevels = texture->levels;
    }
    device->CreateShaderResourceView(texture->resource.Get(), &view, target);
    return true;
  }
  if (binding.kind == FDW_DX_BINDING_ACCELERATION_STRUCTURE) {
    const auto found = context->topLevels.find(object);
    if (found == context->topLevels.end()) {
      return false;
    }
    // A view of the structure by its address, without resource.
    D3D12_SHADER_RESOURCE_VIEW_DESC view{};
    view.ViewDimension = D3D12_SRV_DIMENSION_RAYTRACING_ACCELERATION_STRUCTURE;
    view.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    view.RaytracingAccelerationStructure.Location =
        found->second->storage->GetGPUVirtualAddress();
    device->CreateShaderResourceView(nullptr, &view, target);
    return true;
  }
  const auto found = context->buffers.find(object);
  if (found == context->buffers.end()) {
    return false;
  }
  const fdw_dx_buffer *buffer = found->second;
  if (binding.kind == FDW_DX_BINDING_UNIFORM) {
    D3D12_CONSTANT_BUFFER_VIEW_DESC view{};
    view.BufferLocation = buffer->resource->GetGPUVirtualAddress();
    // At most 64 KB, as the shaders see it.
    view.SizeInBytes = static_cast<UINT>(std::min<uint64_t>(
        buffer->allocated, D3D12_REQ_CONSTANT_BUFFER_ELEMENT_COUNT * 16));
    device->CreateConstantBufferView(&view, target);
    return true;
  }
  // A structured buffer, of elements of the stride of the layout.
  const uint32_t stride = std::max(binding.stride, 4u);
  const UINT elements = static_cast<UINT>(buffer->size / stride);
  if (binding.kind == FDW_DX_BINDING_STORAGE_READ_WRITE) {
    D3D12_UNORDERED_ACCESS_VIEW_DESC view{};
    view.ViewDimension = D3D12_UAV_DIMENSION_BUFFER;
    view.Buffer.NumElements = elements;
    view.Buffer.StructureByteStride = stride;
    device->CreateUnorderedAccessView(
        elements > 0 ? buffer->resource.Get() : nullptr, nullptr, &view,
        target);
    return true;
  }
  D3D12_SHADER_RESOURCE_VIEW_DESC view{};
  view.ViewDimension = D3D12_SRV_DIMENSION_BUFFER;
  view.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
  view.Buffer.NumElements = elements;
  view.Buffer.StructureByteStride = stride;
  device->CreateShaderResourceView(
      elements > 0 ? buffer->resource.Get() : nullptr, &view, target);
  return true;
}

// Serializes and creates a root signature.
int createRootSignature(fdw_dx_context *context,
                        const D3D12_ROOT_SIGNATURE_DESC &desc,
                        ComPtr<ID3D12RootSignature> *result) {
  ComPtr<ID3DBlob> blob;
  ComPtr<ID3DBlob> errors;
  HRESULT status = D3D12SerializeRootSignature(
      &desc, D3D_ROOT_SIGNATURE_VERSION_1_0, &blob, &errors);
  if (FAILED(status)) {
    return fail(std::string("D3D12SerializeRootSignature: ") +
                (errors ? static_cast<const char *>(errors->GetBufferPointer())
                        : "failed"));
  }
  status = context->device->CreateRootSignature(
      0, blob->GetBufferPointer(), blob->GetBufferSize(),
      IID_PPV_ARGS(result->ReleaseAndGetAddressOf()));
  return FAILED(status) ? fail("CreateRootSignature", status) : 0;
}

void releaseSamplerTable(fdw_dx_context *context, const std::string &key) {
  const auto found = context->samplerTables.find(key);
  if (found == context->samplerTables.end() || --found->second.users > 0) {
    return;
  }
  context->samplerHeap.release(static_cast<uint32_t>(found->second.first),
                               found->second.count);
  context->samplerTables.erase(found);
}

void freeGroup(fdw_dx_context *context, fdw_dx_group *group) {
  if (group->resources >= 0) {
    context->views.release(static_cast<uint32_t>(group->resources),
                           static_cast<uint32_t>(group->layout->resources.size()));
  }
  if (!group->samplerKey.empty()) {
    releaseSamplerTable(context, group->samplerKey);
  }
  delete group;
}

} // namespace

namespace fdw {

RootSignature *rootSignature(fdw_dx_context *context,
                             fdw_dx_group_layout *const *groups,
                             uint32_t count, bool compute) {
  std::string key = compute ? "c" : "g";
  for (uint32_t i = 0; i < count; i++) {
    key += ":" + std::to_string(groups[i] ? groups[i]->id : 0);
  }
  auto &cached = context->rootSignatures[key];
  if (cached) {
    return cached.get();
  }
  auto root = std::make_unique<RootSignature>();
  // The ranges must outlive the serialization.
  std::vector<std::vector<D3D12_DESCRIPTOR_RANGE>> ranges;
  std::vector<D3D12_ROOT_PARAMETER> parameters;
  D3D12_ROOT_PARAMETER constants{};
  constants.ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
  constants.Constants = {0, ConstantsSpace, ConstantCount};
  constants.ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  parameters.push_back(constants);
  auto table = [&](const std::vector<fdw_dx_layout_binding> &bindings,
                   uint32_t space) {
    std::vector<D3D12_DESCRIPTOR_RANGE> entries;
    for (uint32_t i = 0; i < bindings.size(); i++) {
      entries.push_back({rangeType(bindings[i].kind), 1, bindings[i].binding,
                         space, i});
    }
    ranges.push_back(std::move(entries));
    return static_cast<int32_t>(ranges.size() - 1);
  };
  // The parameters refer to the ranges once they are all there.
  std::vector<std::pair<size_t, int32_t>> tables;
  for (uint32_t i = 0; i < count; i++) {
    const fdw_dx_group_layout *layout = groups[i];
    int32_t resources = -1;
    int32_t samplers = -1;
    if (layout && !layout->resources.empty()) {
      resources = static_cast<int32_t>(parameters.size());
      tables.emplace_back(parameters.size(), table(layout->resources, i));
      parameters.push_back({});
    }
    if (layout && !layout->samplers.empty()) {
      samplers = static_cast<int32_t>(parameters.size());
      tables.emplace_back(parameters.size(), table(layout->samplers, i));
      parameters.push_back({});
    }
    root->resourceTables.push_back(resources);
    root->samplerTables.push_back(samplers);
  }
  for (const auto &[parameter, range] : tables) {
    D3D12_ROOT_PARAMETER &entry = parameters[parameter];
    entry.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    entry.DescriptorTable.NumDescriptorRanges =
        static_cast<UINT>(ranges[range].size());
    entry.DescriptorTable.pDescriptorRanges = ranges[range].data();
    entry.ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
  }
  D3D12_ROOT_SIGNATURE_DESC desc{};
  desc.NumParameters = static_cast<UINT>(parameters.size());
  desc.pParameters = parameters.data();
  desc.Flags = compute
                   ? D3D12_ROOT_SIGNATURE_FLAG_NONE
                   : D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
  if (createRootSignature(context, desc, &root->signature) != 0) {
    context->rootSignatures.erase(key);
    return nullptr;
  }
  cached = std::move(root);
  return cached.get();
}

void destroyPipelines(fdw_dx_context *context) {
  for (auto &[id, pipeline] : context->pipelines) {
    delete pipeline;
  }
  context->pipelines.clear();
  for (auto &[id, group] : context->groups) {
    freeGroup(context, group);
  }
  context->groups.clear();
  for (auto &[id, layout] : context->groupLayouts) {
    delete layout;
  }
  context->groupLayouts.clear();
  context->rootSignatures.clear();
  for (fdw_dx_shader *shader : context->shaders) {
    delete shader;
  }
  context->shaders.clear();
}

} // namespace fdw

extern "C" {

fdw_dx_group_layout *
fdw_dx_group_layout_create(fdw_dx_context *context,
                           const fdw_dx_layout_binding *bindings,
                           uint32_t count) {
  auto *layout = new fdw_dx_group_layout();
  layout->bindings.assign(bindings, bindings + count);
  for (const fdw_dx_layout_binding &binding : layout->bindings) {
    (binding.kind == FDW_DX_BINDING_SAMPLER ? layout->samplers
                                            : layout->resources)
        .push_back(binding);
  }
  layout->id = context->nextId++;
  context->groupLayouts[layout->id] = layout;
  return layout;
}

uint32_t fdw_dx_group_layout_id(const fdw_dx_group_layout *layout) {
  return layout->id;
}

fdw_dx_group *fdw_dx_group_create(fdw_dx_context *context,
                                  fdw_dx_group_layout *layout,
                                  const fdw_dx_group_entry *entries,
                                  uint32_t count) {
  auto *group = new fdw_dx_group();
  group->layout = layout;
  // The object of each binding of the layout.
  auto objectOf = [&](uint32_t binding, uint32_t *object) {
    for (uint32_t i = 0; i < count; i++) {
      if (entries[i].binding == binding) {
        *object = entries[i].object;
        return true;
      }
    }
    return false;
  };
  const auto resourceCount = static_cast<uint32_t>(layout->resources.size());
  if (resourceCount > 0) {
    group->resources = context->views.allocate(resourceCount);
    if (group->resources < 0) {
      delete group;
      fail("The descriptor heap of the groups is full");
      return nullptr;
    }
  }
  for (uint32_t i = 0; i < resourceCount; i++) {
    const fdw_dx_layout_binding &binding = layout->resources[i];
    uint32_t object = 0;
    if (!objectOf(binding.binding, &object) ||
        !writeDescriptor(context, binding, object,
                         context->views.cpu(static_cast<uint32_t>(
                             group->resources + i)))) {
      freeGroup(context, group);
      fail("No resource for binding " + std::to_string(binding.binding));
      return nullptr;
    }
    group->used.emplace_back(binding.kind, object);
  }
  // The samplers: a table shared by the groups with the same ones (the
  // sampler heap is small).
  if (!layout->samplers.empty()) {
    std::vector<const fdw_dx_sampler *> samplers;
    std::string key;
    for (const fdw_dx_layout_binding &binding : layout->samplers) {
      uint32_t object = 0;
      const auto found = objectOf(binding.binding, &object)
                             ? context->samplers.find(object)
                             : context->samplers.end();
      if (found == context->samplers.end()) {
        freeGroup(context, group);
        fail("No sampler for binding " + std::to_string(binding.binding));
        return nullptr;
      }
      samplers.push_back(found->second);
      key += std::to_string(object) + ",";
    }
    auto &table = context->samplerTables[key];
    if (table.users == 0) {
      table.count = static_cast<uint32_t>(samplers.size());
      table.first = context->samplerHeap.allocate(table.count);
      if (table.first < 0) {
        context->samplerTables.erase(key);
        freeGroup(context, group);
        fail("The sampler heap is full");
        return nullptr;
      }
      for (uint32_t i = 0; i < table.count; i++) {
        context->device->CreateSampler(
            &samplers[i]->desc,
            context->samplerHeap.cpu(static_cast<uint32_t>(table.first + i)));
      }
    }
    table.users++;
    group->samplerKey = key;
    group->samplers = table.first;
  }
  group->id = context->nextId++;
  context->groups[group->id] = group;
  return group;
}

void fdw_dx_group_destroy(fdw_dx_context *context, fdw_dx_group *group) {
  if (!group || !context->groups.erase(group->id)) {
    return;
  }
  defer(context, [context, group] { freeGroup(context, group); });
}

uint32_t fdw_dx_group_id(const fdw_dx_group *group) { return group->id; }

fdw_dx_pipeline *
fdw_dx_render_pipeline_create(fdw_dx_context *context,
                              const fdw_dx_render_pipeline_options *options) {
  if (!options->vertex || options->vertex->stage != 'v') {
    fail("A render pipeline needs a vertex shader");
    return nullptr;
  }
  D3D12_GRAPHICS_PIPELINE_STATE_DESC desc{};
  desc.VS = {options->vertex->bytecode.data(),
             options->vertex->bytecode.size()};
  if (options->fragment) {
    desc.PS = {options->fragment->bytecode.data(),
               options->fragment->bytecode.size()};
  }

  auto *pipeline = new fdw_dx_pipeline();
  std::vector<D3D12_INPUT_ELEMENT_DESC> elements;
  for (uint32_t slot = 0; slot < options->vertex_buffer_count; slot++) {
    const fdw_dx_vertex_buffer &buffer = options->vertex_buffers[slot];
    pipeline->strides.push_back(buffer.stride);
    for (uint32_t i = 0; i < buffer.attribute_count; i++) {
      const fdw_dx_vertex_attribute &attribute = buffer.attributes[i];
      DXGI_FORMAT format;
      if (!vertexFormat(attribute.format, &format)) {
        delete pipeline;
        fail(std::string("Unsupported vertex format ") +
             (attribute.format ? attribute.format : "(none)"));
        return nullptr;
      }
      // Matched with the inputs of the vertex shader by semantic.
      elements.push_back({"ATTRIBUTE", attribute.location, format, slot,
                          attribute.offset,
                          buffer.per_instance
                              ? D3D12_INPUT_CLASSIFICATION_PER_INSTANCE_DATA
                              : D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA,
                          buffer.per_instance ? 1u : 0u});
    }
  }
  desc.InputLayout = {elements.data(), static_cast<UINT>(elements.size())};
  topology(options->topology, &desc.PrimitiveTopologyType,
           &pipeline->topology);

  D3D12_RASTERIZER_DESC &rasterizer = desc.RasterizerState;
  rasterizer.FillMode = D3D12_FILL_MODE_SOLID;
  rasterizer.CullMode = is(options->cull_mode, "front") ? D3D12_CULL_MODE_FRONT
                        : is(options->cull_mode, "back") ? D3D12_CULL_MODE_BACK
                                                         : D3D12_CULL_MODE_NONE;
  // Direct3D sees the winding in clip space as WebGPU does (y up).
  rasterizer.FrontCounterClockwise = is(options->front_face, "cw") ? FALSE : TRUE;
  rasterizer.DepthBias = static_cast<INT>(options->depth_bias);
  rasterizer.SlopeScaledDepthBias = options->depth_bias_slope_scale;
  rasterizer.DepthClipEnable = TRUE;
  rasterizer.MultisampleEnable = options->sample_count > 1;

  D3D12_DEPTH_STENCIL_DESC &depth = desc.DepthStencilState;
  if (options->depth_format) {
    const FormatInfo *format = findFormat(options->depth_format);
    if (!format || !format->depth) {
      delete pipeline;
      fail(std::string("Unsupported depth format ") + options->depth_format);
      return nullptr;
    }
    desc.DSVFormat = format->target;
    depth.DepthEnable = TRUE;
    depth.DepthWriteMask = options->depth_write ? D3D12_DEPTH_WRITE_MASK_ALL
                                                : D3D12_DEPTH_WRITE_MASK_ZERO;
    depth.DepthFunc = compareFunction(options->depth_compare);
  }

  desc.BlendState.IndependentBlendEnable = TRUE;
  if (options->target_count > D3D12_SIMULTANEOUS_RENDER_TARGET_COUNT) {
    delete pipeline;
    fail("Too many color targets");
    return nullptr;
  }
  for (uint32_t i = 0; i < options->target_count; i++) {
    const fdw_dx_color_target &target = options->targets[i];
    const FormatInfo *format = findFormat(target.format);
    if (!format || format->depth || format->target == DXGI_FORMAT_UNKNOWN) {
      delete pipeline;
      fail(std::string("Unsupported color format ") +
           (target.format ? target.format : "(none)"));
      return nullptr;
    }
    desc.RTVFormats[i] = format->target;
    D3D12_RENDER_TARGET_BLEND_DESC &blend = desc.BlendState.RenderTarget[i];
    blend.RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    blend.LogicOp = D3D12_LOGIC_OP_NOOP;
    blend.SrcBlend = D3D12_BLEND_ONE;
    blend.DestBlend = D3D12_BLEND_ZERO;
    blend.BlendOp = D3D12_BLEND_OP_ADD;
    blend.SrcBlendAlpha = D3D12_BLEND_ONE;
    blend.DestBlendAlpha = D3D12_BLEND_ZERO;
    blend.BlendOpAlpha = D3D12_BLEND_OP_ADD;
    if (target.blend) {
      blend.BlendEnable = TRUE;
      blend.SrcBlend = blendFactor(target.color.src_factor);
      blend.DestBlend = blendFactor(target.color.dst_factor);
      blend.BlendOp = blendOperation(target.color.operation);
      blend.SrcBlendAlpha = blendFactor(target.alpha.src_factor);
      blend.DestBlendAlpha = blendFactor(target.alpha.dst_factor);
      blend.BlendOpAlpha = blendOperation(target.alpha.operation);
    }
  }
  desc.NumRenderTargets = options->target_count;
  desc.SampleMask = UINT_MAX;
  desc.SampleDesc.Count = std::max(options->sample_count, 1u);

  pipeline->root = rootSignature(context, options->groups,
                                 options->group_count, false);
  if (!pipeline->root) {
    delete pipeline;
    return nullptr;
  }
  desc.pRootSignature = pipeline->root->signature.Get();
  const HRESULT result = context->device->CreateGraphicsPipelineState(
      &desc, IID_PPV_ARGS(&pipeline->state));
  takeDebugMessages(context);
  if (FAILED(result)) {
    delete pipeline;
    fail("CreateGraphicsPipelineState", result);
    return nullptr;
  }
  setName(pipeline->state.Get(), options->label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

fdw_dx_pipeline *fdw_dx_compute_pipeline_create(
    fdw_dx_context *context, fdw_dx_shader *shader,
    fdw_dx_group_layout *const *groups, uint32_t group_count,
    const char *label) {
  if (!shader || shader->stage != 'c') {
    fail("A compute pipeline needs a compute shader");
    return nullptr;
  }
  auto *pipeline = new fdw_dx_pipeline();
  pipeline->compute = true;
  pipeline->root = rootSignature(context, groups, group_count, true);
  if (!pipeline->root) {
    delete pipeline;
    return nullptr;
  }
  D3D12_COMPUTE_PIPELINE_STATE_DESC desc{};
  desc.pRootSignature = pipeline->root->signature.Get();
  desc.CS = {shader->bytecode.data(), shader->bytecode.size()};
  const HRESULT result = context->device->CreateComputePipelineState(
      &desc, IID_PPV_ARGS(&pipeline->state));
  takeDebugMessages(context);
  if (FAILED(result)) {
    delete pipeline;
    fail("CreateComputePipelineState", result);
    return nullptr;
  }
  setName(pipeline->state.Get(), label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

int32_t fdw_dx_ray_tracing_pipeline_supported(const fdw_dx_context *context) {
  return context->rayQuery ? 1 : 0;
}

fdw_dx_pipeline *fdw_dx_ray_tracing_pipeline_create(
    fdw_dx_context *context, fdw_dx_shader *shader, uint32_t any_hit,
    const uint32_t *workgroup_size, fdw_dx_group_layout *const *groups,
    uint32_t group_count, const char *label) {
  if (!context->rayQuery) {
    fail("The device has no ray tracing pipelines");
    return nullptr;
  }
  if (!shader || shader->stage != 'l') {
    fail("A ray tracing pipeline needs a library of ray tracing shaders");
    return nullptr;
  }
  auto *pipeline = new fdw_dx_pipeline();
  pipeline->compute = true;
  for (int k = 0; k < 3; k++) {
    pipeline->workgroupSize[k] = std::max(workgroup_size[k], 1u);
  }
  // The root signature of the compute pipelines, global to the shaders.
  pipeline->root = rootSignature(context, groups, group_count, true);
  if (!pipeline->root) {
    delete pipeline;
    return nullptr;
  }
  // The entry points of the library (see RayTracingEntryPoints), and the
  // hit group of the triangles.
  const wchar_t *hitGroup = L"fdw_hit";
  D3D12_EXPORT_DESC exports[] = {
      {L"rg_main", nullptr, D3D12_EXPORT_FLAG_NONE},
      {L"ms_main", nullptr, D3D12_EXPORT_FLAG_NONE},
      {L"ch_main", nullptr, D3D12_EXPORT_FLAG_NONE},
      {L"ah_main", nullptr, D3D12_EXPORT_FLAG_NONE},
  };
  D3D12_DXIL_LIBRARY_DESC library{};
  library.DXILLibrary = {shader->bytecode.data(), shader->bytecode.size()};
  library.NumExports = any_hit ? 4 : 3;
  library.pExports = exports;
  D3D12_HIT_GROUP_DESC hit{};
  hit.HitGroupExport = hitGroup;
  hit.Type = D3D12_HIT_GROUP_TYPE_TRIANGLES;
  hit.ClosestHitShaderImport = L"ch_main";
  hit.AnyHitShaderImport = any_hit ? L"ah_main" : nullptr;
  // The payload: the hit (uint4); the attributes: the barycentrics.
  D3D12_RAYTRACING_SHADER_CONFIG config{16, 8};
  D3D12_GLOBAL_ROOT_SIGNATURE global{pipeline->root->signature.Get()};
  // The hit and miss shaders trace no rays.
  D3D12_RAYTRACING_PIPELINE_CONFIG depth{1};
  const D3D12_STATE_SUBOBJECT subobjects[] = {
      {D3D12_STATE_SUBOBJECT_TYPE_DXIL_LIBRARY, &library},
      {D3D12_STATE_SUBOBJECT_TYPE_HIT_GROUP, &hit},
      {D3D12_STATE_SUBOBJECT_TYPE_RAYTRACING_SHADER_CONFIG, &config},
      {D3D12_STATE_SUBOBJECT_TYPE_GLOBAL_ROOT_SIGNATURE, &global},
      {D3D12_STATE_SUBOBJECT_TYPE_RAYTRACING_PIPELINE_CONFIG, &depth},
  };
  D3D12_STATE_OBJECT_DESC desc{D3D12_STATE_OBJECT_TYPE_RAYTRACING_PIPELINE,
                               _countof(subobjects), subobjects};
  HRESULT result = context->rayDevice->CreateStateObject(
      &desc, IID_PPV_ARGS(&pipeline->rays));
  takeDebugMessages(context);
  if (FAILED(result)) {
    delete pipeline;
    fail("CreateStateObject", result);
    return nullptr;
  }
  ComPtr<ID3D12StateObjectProperties> properties;
  result = pipeline->rays.As(&properties);
  if (FAILED(result)) {
    delete pipeline;
    fail("ID3D12StateObjectProperties", result);
    return nullptr;
  }
  // The shader table: a record per group (its identifier), each at the
  // start of a table, written in the order of the queue.
  const void *identifiers[] = {properties->GetShaderIdentifier(L"rg_main"),
                               properties->GetShaderIdentifier(L"ms_main"),
                               properties->GetShaderIdentifier(hitGroup)};
  pipeline->tableStride = D3D12_RAYTRACING_SHADER_TABLE_BYTE_ALIGNMENT;
  std::vector<uint8_t> table(size_t(pipeline->tableStride) * 3);
  for (uint32_t group = 0; group < 3; group++) {
    if (!identifiers[group]) {
      delete pipeline;
      fail("A shader of the ray tracing pipeline has no identifier");
      return nullptr;
    }
    std::memcpy(table.data() + group * pipeline->tableStride,
                identifiers[group], D3D12_SHADER_IDENTIFIER_SIZE_IN_BYTES);
  }
  pipeline->shaderTable =
      fdw_dx_buffer_create(context, table.size(), 0, label);
  if (!pipeline->shaderTable ||
      fdw_dx_buffer_write(context, pipeline->shaderTable, 0, table.data(),
                          table.size()) != 0) {
    fdw_dx_buffer_destroy(context, pipeline->shaderTable);
    delete pipeline;
    return nullptr;
  }
  setName(pipeline->rays.Get(), label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

void fdw_dx_pipeline_destroy(fdw_dx_context *context,
                             fdw_dx_pipeline *pipeline) {
  if (!pipeline || !context->pipelines.erase(pipeline->id)) {
    return;
  }
  fdw_dx_buffer_destroy(context, pipeline->shaderTable);
  defer(context, [pipeline] { delete pipeline; });
}

uint32_t fdw_dx_pipeline_id(const fdw_dx_pipeline *pipeline) {
  return pipeline->id;
}

} // extern "C"
