// Groups of resources (descriptor sets), their layouts, and the pipelines.

#include "context.hpp"

#include <cstring>
#include <string_view>

using namespace fdw;

namespace {

VkDescriptorType descriptorType(fdw_vk_binding_kind kind) {
  switch (kind) {
  case FDW_VK_BINDING_UNIFORM:
    return VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
  case FDW_VK_BINDING_TEXTURE:
    return VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE;
  case FDW_VK_BINDING_SAMPLER:
    return VK_DESCRIPTOR_TYPE_SAMPLER;
  case FDW_VK_BINDING_STORAGE_READ:
  case FDW_VK_BINDING_STORAGE_READ_WRITE:
    return VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
  case FDW_VK_BINDING_ACCELERATION_STRUCTURE:
    return VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
  }
  return VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
}

// A descriptor pool with room for many groups, freeable one by one.
VkDescriptorPool createPool(fdw_vk_context *context) {
  // The acceleration structures last, where the device has them.
  const VkDescriptorPoolSize sizes[] = {
      {VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1024},
      {VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1024},
      {VK_DESCRIPTOR_TYPE_SAMPLER, 1024},
      {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1024},
      {VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR, 256},
  };
  VkDescriptorPoolCreateInfo info{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
  info.flags = VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT;
  info.maxSets = 1024;
  info.poolSizeCount =
      sizeof(sizes) / sizeof(sizes[0]) - (context->rayQuery ? 0 : 1);
  info.pPoolSizes = sizes;
  VkDescriptorPool pool = VK_NULL_HANDLE;
  const VkResult result =
      vkCreateDescriptorPool(context->device, &info, nullptr, &pool);
  if (result != VK_SUCCESS) {
    fail("vkCreateDescriptorPool", result);
    return VK_NULL_HANDLE;
  }
  context->descriptorPools.push_back(pool);
  return pool;
}

// Allocates a set from the last pool, or from a new one when it is full.
int allocateSet(fdw_vk_context *context, VkDescriptorSetLayout layout,
                VkDescriptorSet *set, VkDescriptorPool *pool) {
  for (int attempt = 0; attempt < 2; attempt++) {
    VkDescriptorPool candidate = context->descriptorPools.empty() || attempt > 0
                                     ? createPool(context)
                                     : context->descriptorPools.back();
    if (!candidate) {
      return -1;
    }
    VkDescriptorSetAllocateInfo info{
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    info.descriptorPool = candidate;
    info.descriptorSetCount = 1;
    info.pSetLayouts = &layout;
    const VkResult result = vkAllocateDescriptorSets(context->device, &info, set);
    if (result == VK_SUCCESS) {
      *pool = candidate;
      return 0;
    }
    if (result != VK_ERROR_OUT_OF_POOL_MEMORY &&
        result != VK_ERROR_FRAGMENTED_POOL) {
      return fail("vkAllocateDescriptorSets", result);
    }
  }
  return fail("Cannot allocate a descriptor set");
}

VkDescriptorSetLayout emptyLayout(fdw_vk_context *context) {
  if (!context->emptyGroupLayout) {
    VkDescriptorSetLayoutCreateInfo info{
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    vkCreateDescriptorSetLayout(context->device, &info, nullptr,
                                &context->emptyGroupLayout);
  }
  return context->emptyGroupLayout;
}

struct VertexFormat {
  std::string_view name;
  VkFormat format;
};

constexpr VertexFormat vertexFormats[] = {
    {"float32", VK_FORMAT_R32_SFLOAT},
    {"float32x2", VK_FORMAT_R32G32_SFLOAT},
    {"float32x3", VK_FORMAT_R32G32B32_SFLOAT},
    {"float32x4", VK_FORMAT_R32G32B32A32_SFLOAT},
    {"float16x2", VK_FORMAT_R16G16_SFLOAT},
    {"float16x4", VK_FORMAT_R16G16B16A16_SFLOAT},
    {"uint32", VK_FORMAT_R32_UINT},
    {"uint32x2", VK_FORMAT_R32G32_UINT},
    {"uint32x3", VK_FORMAT_R32G32B32_UINT},
    {"uint32x4", VK_FORMAT_R32G32B32A32_UINT},
    {"sint32", VK_FORMAT_R32_SINT},
    {"sint32x2", VK_FORMAT_R32G32_SINT},
    {"sint32x3", VK_FORMAT_R32G32B32_SINT},
    {"sint32x4", VK_FORMAT_R32G32B32A32_SINT},
    {"uint8x2", VK_FORMAT_R8G8_UINT},
    {"uint8x4", VK_FORMAT_R8G8B8A8_UINT},
    {"sint8x2", VK_FORMAT_R8G8_SINT},
    {"sint8x4", VK_FORMAT_R8G8B8A8_SINT},
    {"unorm8x2", VK_FORMAT_R8G8_UNORM},
    {"unorm8x4", VK_FORMAT_R8G8B8A8_UNORM},
    {"snorm8x2", VK_FORMAT_R8G8_SNORM},
    {"snorm8x4", VK_FORMAT_R8G8B8A8_SNORM},
    {"uint16x2", VK_FORMAT_R16G16_UINT},
    {"uint16x4", VK_FORMAT_R16G16B16A16_UINT},
    {"sint16x2", VK_FORMAT_R16G16_SINT},
    {"sint16x4", VK_FORMAT_R16G16B16A16_SINT},
    {"unorm16x2", VK_FORMAT_R16G16_UNORM},
    {"unorm16x4", VK_FORMAT_R16G16B16A16_UNORM},
    {"snorm16x2", VK_FORMAT_R16G16_SNORM},
    {"snorm16x4", VK_FORMAT_R16G16B16A16_SNORM},
};

bool vertexFormat(const char *name, VkFormat *format) {
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

VkBlendFactor blendFactor(const char *name) {
  if (is(name, "zero")) {
    return VK_BLEND_FACTOR_ZERO;
  }
  if (is(name, "src-alpha")) {
    return VK_BLEND_FACTOR_SRC_ALPHA;
  }
  if (is(name, "one-minus-src-alpha")) {
    return VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
  }
  if (is(name, "dst-alpha")) {
    return VK_BLEND_FACTOR_DST_ALPHA;
  }
  if (is(name, "one-minus-dst-alpha")) {
    return VK_BLEND_FACTOR_ONE_MINUS_DST_ALPHA;
  }
  return VK_BLEND_FACTOR_ONE;
}

VkBlendOp blendOperation(const char *name) {
  if (is(name, "subtract")) {
    return VK_BLEND_OP_SUBTRACT;
  }
  if (is(name, "reverse-subtract")) {
    return VK_BLEND_OP_REVERSE_SUBTRACT;
  }
  if (is(name, "min")) {
    return VK_BLEND_OP_MIN;
  }
  if (is(name, "max")) {
    return VK_BLEND_OP_MAX;
  }
  return VK_BLEND_OP_ADD;
}

VkCompareOp compareOperation(const char *name) {
  if (is(name, "never")) {
    return VK_COMPARE_OP_NEVER;
  }
  if (is(name, "less")) {
    return VK_COMPARE_OP_LESS;
  }
  if (is(name, "equal")) {
    return VK_COMPARE_OP_EQUAL;
  }
  if (is(name, "less-equal")) {
    return VK_COMPARE_OP_LESS_OR_EQUAL;
  }
  if (is(name, "greater")) {
    return VK_COMPARE_OP_GREATER;
  }
  if (is(name, "not-equal")) {
    return VK_COMPARE_OP_NOT_EQUAL;
  }
  if (is(name, "greater-equal")) {
    return VK_COMPARE_OP_GREATER_OR_EQUAL;
  }
  return VK_COMPARE_OP_ALWAYS;
}

VkPrimitiveTopology topology(const char *name) {
  if (is(name, "triangle-strip")) {
    return VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP;
  }
  if (is(name, "line-list")) {
    return VK_PRIMITIVE_TOPOLOGY_LINE_LIST;
  }
  if (is(name, "line-strip")) {
    return VK_PRIMITIVE_TOPOLOGY_LINE_STRIP;
  }
  if (is(name, "point-list")) {
    return VK_PRIMITIVE_TOPOLOGY_POINT_LIST;
  }
  return VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
}

// The layout of a pipeline: the layouts of its groups, empty ones included.
int pipelineLayout(fdw_vk_context *context,
                   fdw_vk_group_layout *const *groups, uint32_t count,
                   fdw_vk_pipeline *pipeline) {
  std::vector<VkDescriptorSetLayout> sets;
  for (uint32_t i = 0; i < count; i++) {
    sets.push_back(groups[i] ? groups[i]->layout : emptyLayout(context));
    pipeline->usedSets.push_back(groups[i] != nullptr);
  }
  VkPipelineLayout *layout = &pipeline->layout;
  VkPipelineLayoutCreateInfo info{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
  info.setLayoutCount = static_cast<uint32_t>(sets.size());
  info.pSetLayouts = sets.data();
  const VkResult result =
      vkCreatePipelineLayout(context->device, &info, nullptr, layout);
  return result == VK_SUCCESS ? 0 : fail("vkCreatePipelineLayout", result);
}

} // namespace

namespace fdw {

void destroyPipelines(fdw_vk_context *context) {
  for (auto &[id, pipeline] : context->pipelines) {
    vkDestroyPipeline(context->device, pipeline->pipeline, nullptr);
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
  }
  context->pipelines.clear();
  for (auto &[id, group] : context->groups) {
    delete group;
  }
  context->groups.clear();
  for (VkDescriptorPool pool : context->descriptorPools) {
    vkDestroyDescriptorPool(context->device, pool, nullptr);
  }
  context->descriptorPools.clear();
  for (auto &[id, layout] : context->groupLayouts) {
    vkDestroyDescriptorSetLayout(context->device, layout->layout, nullptr);
    delete layout;
  }
  context->groupLayouts.clear();
  if (context->emptyGroupLayout) {
    vkDestroyDescriptorSetLayout(context->device, context->emptyGroupLayout,
                                 nullptr);
    context->emptyGroupLayout = VK_NULL_HANDLE;
  }
  for (fdw_vk_shader *shader : context->shaders) {
    vkDestroyShaderModule(context->device, shader->module, nullptr);
    delete shader;
  }
  context->shaders.clear();
}

} // namespace fdw

extern "C" {

fdw_vk_group_layout *
fdw_vk_group_layout_create(fdw_vk_context *context,
                           const fdw_vk_layout_binding *bindings,
                           uint32_t count) {
  std::vector<VkDescriptorSetLayoutBinding> entries;
  for (uint32_t i = 0; i < count; i++) {
    VkDescriptorSetLayoutBinding entry{};
    entry.binding = bindings[i].binding;
    entry.descriptorType = descriptorType(bindings[i].kind);
    entry.descriptorCount = 1;
    // Every stage that can see the resource does, as in the WebGPU backend:
    // groups are shared between render and compute pipelines.
    entry.stageFlags = VK_SHADER_STAGE_VERTEX_BIT |
                       VK_SHADER_STAGE_FRAGMENT_BIT |
                       VK_SHADER_STAGE_COMPUTE_BIT;
    // And the shaders of the ray tracing pipelines.
    if (context->rayTracingPipeline) {
      entry.stageFlags |= VK_SHADER_STAGE_RAYGEN_BIT_KHR |
                          VK_SHADER_STAGE_MISS_BIT_KHR |
                          VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR |
                          VK_SHADER_STAGE_ANY_HIT_BIT_KHR;
    }
    entries.push_back(entry);
  }
  VkDescriptorSetLayoutCreateInfo info{
      VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
  info.bindingCount = count;
  info.pBindings = entries.data();
  auto *layout = new fdw_vk_group_layout();
  const VkResult result = vkCreateDescriptorSetLayout(context->device, &info,
                                                      nullptr, &layout->layout);
  if (result != VK_SUCCESS) {
    delete layout;
    fail("vkCreateDescriptorSetLayout", result);
    return nullptr;
  }
  layout->bindings.assign(bindings, bindings + count);
  layout->id = context->nextId++;
  context->groupLayouts[layout->id] = layout;
  return layout;
}

uint32_t fdw_vk_group_layout_id(const fdw_vk_group_layout *layout) {
  return layout->id;
}

fdw_vk_group *fdw_vk_group_create(fdw_vk_context *context,
                                  fdw_vk_group_layout *layout,
                                  const fdw_vk_group_entry *entries,
                                  uint32_t count) {
  auto *group = new fdw_vk_group();
  if (allocateSet(context, layout->layout, &group->set, &group->pool) != 0) {
    delete group;
    return nullptr;
  }
  // The descriptors, one per entry; the infos must outlive the update.
  std::vector<VkDescriptorBufferInfo> buffers(count);
  std::vector<VkDescriptorImageInfo> images(count);
  std::vector<VkWriteDescriptorSetAccelerationStructureKHR> structures(count);
  std::vector<VkWriteDescriptorSet> writes;
  for (uint32_t i = 0; i < count; i++) {
    const fdw_vk_group_entry &entry = entries[i];
    const fdw_vk_layout_binding *binding = nullptr;
    for (const fdw_vk_layout_binding &candidate : layout->bindings) {
      if (candidate.binding == entry.binding) {
        binding = &candidate;
      }
    }
    if (!binding) {
      vkFreeDescriptorSets(context->device, group->pool, 1, &group->set);
      delete group;
      fail("The layout has no binding " + std::to_string(entry.binding));
      return nullptr;
    }
    VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
    write.dstSet = group->set;
    write.dstBinding = entry.binding;
    write.descriptorCount = 1;
    write.descriptorType = descriptorType(binding->kind);
    bool found = false;
    switch (binding->kind) {
    case FDW_VK_BINDING_UNIFORM:
    case FDW_VK_BINDING_STORAGE_READ:
    case FDW_VK_BINDING_STORAGE_READ_WRITE: {
      const auto buffer = context->buffers.find(entry.object);
      if ((found = buffer != context->buffers.end())) {
        buffers[i] = {buffer->second->buffer, 0, VK_WHOLE_SIZE};
        write.pBufferInfo = &buffers[i];
      }
      break;
    }
    case FDW_VK_BINDING_TEXTURE: {
      const auto texture = context->textures.find(entry.object);
      if ((found = texture != context->textures.end())) {
        images[i] = {VK_NULL_HANDLE, texture->second->view,
                     VK_IMAGE_LAYOUT_READ_ONLY_OPTIMAL};
        write.pImageInfo = &images[i];
      }
      break;
    }
    case FDW_VK_BINDING_ACCELERATION_STRUCTURE: {
      const auto top = context->topLevels.find(entry.object);
      if ((found = top != context->topLevels.end())) {
        structures[i] = {
            VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_ACCELERATION_STRUCTURE_KHR};
        structures[i].accelerationStructureCount = 1;
        structures[i].pAccelerationStructures = &top->second->structure;
        write.pNext = &structures[i];
      }
      break;
    }
    case FDW_VK_BINDING_SAMPLER: {
      const auto sampler = context->samplers.find(entry.object);
      if ((found = sampler != context->samplers.end())) {
        images[i] = {sampler->second->sampler, VK_NULL_HANDLE,
                     VK_IMAGE_LAYOUT_UNDEFINED};
        write.pImageInfo = &images[i];
      }
      break;
    }
    }
    if (!found) {
      vkFreeDescriptorSets(context->device, group->pool, 1, &group->set);
      delete group;
      fail("Unknown resource " + std::to_string(entry.object) +
           " for binding " + std::to_string(entry.binding));
      return nullptr;
    }
    writes.push_back(write);
    if (binding->kind != FDW_VK_BINDING_SAMPLER) {
      group->resources.emplace_back(binding->kind, entry.object);
    }
  }
  vkUpdateDescriptorSets(context->device, static_cast<uint32_t>(writes.size()),
                         writes.data(), 0, nullptr);
  group->id = context->nextId++;
  context->groups[group->id] = group;
  return group;
}

void fdw_vk_group_destroy(fdw_vk_context *context, fdw_vk_group *group) {
  if (!group || !context->groups.erase(group->id)) {
    return;
  }
  VkDevice device = context->device;
  defer(context, [device, group] {
    vkFreeDescriptorSets(device, group->pool, 1, &group->set);
    delete group;
  });
}

uint32_t fdw_vk_group_id(const fdw_vk_group *group) { return group->id; }

fdw_vk_pipeline *
fdw_vk_render_pipeline_create(fdw_vk_context *context,
                              const fdw_vk_render_pipeline_options *options) {
  std::vector<VkPipelineShaderStageCreateInfo> stages;
  for (fdw_vk_shader *shader : {options->vertex, options->fragment}) {
    if (!shader) {
      continue;
    }
    VkPipelineShaderStageCreateInfo stage{
        VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
    stage.stage = shader->stage;
    stage.module = shader->module;
    stage.pName = shader->entryPoint.c_str();
    stages.push_back(stage);
  }

  std::vector<VkVertexInputBindingDescription> bindings;
  std::vector<VkVertexInputAttributeDescription> attributes;
  for (uint32_t slot = 0; slot < options->vertex_buffer_count; slot++) {
    const fdw_vk_vertex_buffer &buffer = options->vertex_buffers[slot];
    bindings.push_back({slot, buffer.stride,
                        buffer.per_instance ? VK_VERTEX_INPUT_RATE_INSTANCE
                                            : VK_VERTEX_INPUT_RATE_VERTEX});
    for (uint32_t i = 0; i < buffer.attribute_count; i++) {
      const fdw_vk_vertex_attribute &attribute = buffer.attributes[i];
      VkFormat format;
      if (!vertexFormat(attribute.format, &format)) {
        fail(std::string("Unsupported vertex format ") +
             (attribute.format ? attribute.format : "(none)"));
        return nullptr;
      }
      attributes.push_back({attribute.location, slot, format, attribute.offset});
    }
  }
  VkPipelineVertexInputStateCreateInfo vertexInput{
      VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
  vertexInput.vertexBindingDescriptionCount =
      static_cast<uint32_t>(bindings.size());
  vertexInput.pVertexBindingDescriptions = bindings.data();
  vertexInput.vertexAttributeDescriptionCount =
      static_cast<uint32_t>(attributes.size());
  vertexInput.pVertexAttributeDescriptions = attributes.data();

  VkPipelineInputAssemblyStateCreateInfo inputAssembly{
      VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
  inputAssembly.topology = topology(options->topology);

  VkPipelineViewportStateCreateInfo viewport{
      VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
  viewport.viewportCount = 1;
  viewport.scissorCount = 1;

  VkPipelineRasterizationStateCreateInfo rasterization{
      VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
  rasterization.polygonMode = VK_POLYGON_MODE_FILL;
  rasterization.cullMode = is(options->cull_mode, "front") ? VK_CULL_MODE_FRONT_BIT
                           : is(options->cull_mode, "back") ? VK_CULL_MODE_BACK_BIT
                                                            : VK_CULL_MODE_NONE;
  // With the viewport of negative height, the winding seen in clip space
  // (y up, as in WebGPU) is kept.
  rasterization.frontFace = is(options->front_face, "cw")
                                ? VK_FRONT_FACE_CLOCKWISE
                                : VK_FRONT_FACE_COUNTER_CLOCKWISE;
  rasterization.depthBiasEnable =
      options->depth_bias != 0 || options->depth_bias_slope_scale != 0;
  rasterization.depthBiasConstantFactor = options->depth_bias;
  rasterization.depthBiasSlopeFactor = options->depth_bias_slope_scale;
  rasterization.lineWidth = 1;

  VkPipelineMultisampleStateCreateInfo multisample{
      VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
  multisample.rasterizationSamples = static_cast<VkSampleCountFlagBits>(
      std::max(options->sample_count, 1u));

  VkPipelineDepthStencilStateCreateInfo depth{
      VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};
  VkFormat depthFormat = VK_FORMAT_UNDEFINED;
  VkFormat stencilFormat = VK_FORMAT_UNDEFINED;
  if (options->depth_format) {
    const FormatInfo *format = findFormat(options->depth_format);
    if (!format) {
      fail(std::string("Unsupported depth format ") + options->depth_format);
      return nullptr;
    }
    depthFormat = format->format;
    if (format->aspect & VK_IMAGE_ASPECT_STENCIL_BIT) {
      stencilFormat = format->format;
    }
    depth.depthTestEnable = VK_TRUE;
    depth.depthWriteEnable = options->depth_write ? VK_TRUE : VK_FALSE;
    depth.depthCompareOp = compareOperation(options->depth_compare);
  }

  std::vector<VkPipelineColorBlendAttachmentState> blends;
  std::vector<VkFormat> colorFormats;
  for (uint32_t i = 0; i < options->target_count; i++) {
    const fdw_vk_color_target &target = options->targets[i];
    const FormatInfo *format = findFormat(target.format);
    if (!format) {
      fail(std::string("Unsupported color format ") +
           (target.format ? target.format : "(none)"));
      return nullptr;
    }
    colorFormats.push_back(format->format);
    VkPipelineColorBlendAttachmentState blend{};
    blend.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                           VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    if (target.blend) {
      blend.blendEnable = VK_TRUE;
      blend.srcColorBlendFactor = blendFactor(target.color.src_factor);
      blend.dstColorBlendFactor = blendFactor(target.color.dst_factor);
      blend.colorBlendOp = blendOperation(target.color.operation);
      blend.srcAlphaBlendFactor = blendFactor(target.alpha.src_factor);
      blend.dstAlphaBlendFactor = blendFactor(target.alpha.dst_factor);
      blend.alphaBlendOp = blendOperation(target.alpha.operation);
    }
    blends.push_back(blend);
  }
  VkPipelineColorBlendStateCreateInfo colorBlend{
      VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
  colorBlend.attachmentCount = static_cast<uint32_t>(blends.size());
  colorBlend.pAttachments = blends.data();

  const VkDynamicState dynamicStates[] = {VK_DYNAMIC_STATE_VIEWPORT,
                                          VK_DYNAMIC_STATE_SCISSOR};
  VkPipelineDynamicStateCreateInfo dynamic{
      VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};
  dynamic.dynamicStateCount = 2;
  dynamic.pDynamicStates = dynamicStates;

  VkPipelineRenderingCreateInfo rendering{
      VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO};
  rendering.colorAttachmentCount = static_cast<uint32_t>(colorFormats.size());
  rendering.pColorAttachmentFormats = colorFormats.data();
  rendering.depthAttachmentFormat = depthFormat;
  rendering.stencilAttachmentFormat = stencilFormat;

  auto *pipeline = new fdw_vk_pipeline();
  if (pipelineLayout(context, options->groups, options->group_count,
                     pipeline) != 0) {
    delete pipeline;
    return nullptr;
  }
  VkGraphicsPipelineCreateInfo info{
      VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, &rendering};
  info.stageCount = static_cast<uint32_t>(stages.size());
  info.pStages = stages.data();
  info.pVertexInputState = &vertexInput;
  info.pInputAssemblyState = &inputAssembly;
  info.pViewportState = &viewport;
  info.pRasterizationState = &rasterization;
  info.pMultisampleState = &multisample;
  info.pDepthStencilState = &depth;
  info.pColorBlendState = &colorBlend;
  info.pDynamicState = &dynamic;
  info.layout = pipeline->layout;
  const VkResult result = vkCreateGraphicsPipelines(
      context->device, VK_NULL_HANDLE, 1, &info, nullptr, &pipeline->pipeline);
  if (result != VK_SUCCESS) {
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
    fail("vkCreateGraphicsPipelines", result);
    return nullptr;
  }
  setName(context, VK_OBJECT_TYPE_PIPELINE,
          reinterpret_cast<uint64_t>(pipeline->pipeline), options->label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

fdw_vk_pipeline *fdw_vk_compute_pipeline_create(
    fdw_vk_context *context, fdw_vk_shader *shader,
    fdw_vk_group_layout *const *groups, uint32_t group_count,
    const char *label) {
  if (!shader || shader->stage != VK_SHADER_STAGE_COMPUTE_BIT) {
    fail("A compute pipeline needs a compute shader");
    return nullptr;
  }
  auto *pipeline = new fdw_vk_pipeline();
  pipeline->bindPoint = VK_PIPELINE_BIND_POINT_COMPUTE;
  if (pipelineLayout(context, groups, group_count, pipeline) != 0) {
    delete pipeline;
    return nullptr;
  }
  VkComputePipelineCreateInfo info{
      VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
  info.stage = {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
  info.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
  info.stage.module = shader->module;
  info.stage.pName = shader->entryPoint.c_str();
  info.layout = pipeline->layout;
  const VkResult result = vkCreateComputePipelines(
      context->device, VK_NULL_HANDLE, 1, &info, nullptr, &pipeline->pipeline);
  if (result != VK_SUCCESS) {
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
    fail("vkCreateComputePipelines", result);
    return nullptr;
  }
  setName(context, VK_OBJECT_TYPE_PIPELINE,
          reinterpret_cast<uint64_t>(pipeline->pipeline), label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

int32_t fdw_vk_ray_tracing_pipeline_supported(const fdw_vk_context *context) {
  return context->rayTracingPipeline ? 1 : 0;
}

fdw_vk_pipeline *fdw_vk_ray_tracing_pipeline_create(
    fdw_vk_context *context, fdw_vk_shader *shader, uint32_t any_hit,
    const uint32_t *workgroup_size, fdw_vk_group_layout *const *groups,
    uint32_t group_count, const char *label) {
  if (!context->rayTracingPipeline) {
    fail("The device has no ray tracing pipelines");
    return nullptr;
  }
  if (!shader || shader->stage != VK_SHADER_STAGE_RAYGEN_BIT_KHR) {
    fail("A ray tracing pipeline needs a library of ray tracing shaders");
    return nullptr;
  }
  auto *pipeline = new fdw_vk_pipeline();
  pipeline->bindPoint = VK_PIPELINE_BIND_POINT_RAY_TRACING_KHR;
  for (int k = 0; k < 3; k++) {
    pipeline->workgroupSize[k] = std::max(workgroup_size[k], 1u);
  }
  if (pipelineLayout(context, groups, group_count, pipeline) != 0) {
    delete pipeline;
    return nullptr;
  }
  // The entry points of the library (see RayTracingEntryPoints).
  const struct {
    VkShaderStageFlagBits stage;
    const char *name;
  } entries[] = {
      {VK_SHADER_STAGE_RAYGEN_BIT_KHR, "rg_main"},
      {VK_SHADER_STAGE_MISS_BIT_KHR, "ms_main"},
      {VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR, "ch_main"},
      {VK_SHADER_STAGE_ANY_HIT_BIT_KHR, "ah_main"},
  };
  const uint32_t stageCount = any_hit ? 4 : 3;
  std::vector<VkPipelineShaderStageCreateInfo> stages(stageCount);
  for (uint32_t i = 0; i < stageCount; i++) {
    stages[i] = {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
    stages[i].stage = entries[i].stage;
    stages[i].module = shader->module;
    stages[i].pName = entries[i].name;
  }
  // The groups: the ray generation, the miss, the hit of the triangles.
  VkRayTracingShaderGroupCreateInfoKHR shaderGroups[3];
  for (auto &group : shaderGroups) {
    group = {VK_STRUCTURE_TYPE_RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR};
    group.generalShader = VK_SHADER_UNUSED_KHR;
    group.closestHitShader = VK_SHADER_UNUSED_KHR;
    group.anyHitShader = VK_SHADER_UNUSED_KHR;
    group.intersectionShader = VK_SHADER_UNUSED_KHR;
  }
  shaderGroups[0].type = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
  shaderGroups[0].generalShader = 0;
  shaderGroups[1].type = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
  shaderGroups[1].generalShader = 1;
  shaderGroups[2].type =
      VK_RAY_TRACING_SHADER_GROUP_TYPE_TRIANGLES_HIT_GROUP_KHR;
  shaderGroups[2].closestHitShader = 2;
  if (any_hit) {
    shaderGroups[2].anyHitShader = 3;
  }
  VkRayTracingPipelineCreateInfoKHR info{
      VK_STRUCTURE_TYPE_RAY_TRACING_PIPELINE_CREATE_INFO_KHR};
  info.stageCount = stageCount;
  info.pStages = stages.data();
  info.groupCount = 3;
  info.pGroups = shaderGroups;
  // The hit and miss shaders trace no rays.
  info.maxPipelineRayRecursionDepth = 1;
  info.layout = pipeline->layout;
  const VkResult result = vkCreateRayTracingPipelinesKHR(
      context->device, VK_NULL_HANDLE, VK_NULL_HANDLE, 1, &info, nullptr,
      &pipeline->pipeline);
  if (result != VK_SUCCESS) {
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
    fail("vkCreateRayTracingPipelinesKHR", result);
    return nullptr;
  }
  // The shader table: a record per group, each region at the base
  // alignment, written in the order of the queue.
  const uint32_t handleSize = context->shaderGroupHandleSize;
  const auto align = [](uint64_t value, uint64_t to) {
    return (value + to - 1) / to * to;
  };
  const uint64_t stride =
      align(handleSize, context->shaderGroupHandleAlignment);
  const uint64_t region = align(stride, context->shaderGroupBaseAlignment);
  std::vector<uint8_t> handles(size_t(handleSize) * 3);
  std::vector<uint8_t> table(size_t(region) * 3);
  if (vkGetRayTracingShaderGroupHandlesKHR(context->device, pipeline->pipeline,
                                           0, 3, handles.size(),
                                           handles.data()) != VK_SUCCESS) {
    vkDestroyPipeline(context->device, pipeline->pipeline, nullptr);
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
    fail("vkGetRayTracingShaderGroupHandlesKHR failed");
    return nullptr;
  }
  for (uint32_t group = 0; group < 3; group++) {
    std::memcpy(table.data() + group * region,
                handles.data() + group * handleSize, handleSize);
  }
  pipeline->shaderTable = createBuffer(
      context, table.size(),
      VK_BUFFER_USAGE_SHADER_BINDING_TABLE_BIT_KHR |
          VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
      label);
  if (!pipeline->shaderTable ||
      fdw_vk_buffer_write(context, pipeline->shaderTable, 0, table.data(),
                          table.size()) != 0) {
    fdw_vk_buffer_destroy(context, pipeline->shaderTable);
    vkDestroyPipeline(context->device, pipeline->pipeline, nullptr);
    vkDestroyPipelineLayout(context->device, pipeline->layout, nullptr);
    delete pipeline;
    return nullptr;
  }
  const VkDeviceAddress base =
      bufferAddress(context, pipeline->shaderTable->buffer);
  // The ray generation region: its size its stride.
  pipeline->generationRegion = {base, region, region};
  pipeline->missRegion = {base + region, stride, stride};
  pipeline->hitRegion = {base + 2 * region, stride, stride};
  setName(context, VK_OBJECT_TYPE_PIPELINE,
          reinterpret_cast<uint64_t>(pipeline->pipeline), label);
  pipeline->id = context->nextId++;
  context->pipelines[pipeline->id] = pipeline;
  return pipeline;
}

void fdw_vk_pipeline_destroy(fdw_vk_context *context,
                             fdw_vk_pipeline *pipeline) {
  if (!pipeline || !context->pipelines.erase(pipeline->id)) {
    return;
  }
  fdw_vk_buffer_destroy(context, pipeline->shaderTable);
  VkDevice device = context->device;
  defer(context, [device, pipeline] {
    vkDestroyPipeline(device, pipeline->pipeline, nullptr);
    vkDestroyPipelineLayout(device, pipeline->layout, nullptr);
    delete pipeline;
  });
}

uint32_t fdw_vk_pipeline_id(const fdw_vk_pipeline *pipeline) {
  return pipeline->id;
}

} // extern "C"
