// The replay of the commands of a submission (FDW_VK_CMD_*), with the
// barriers that the uses of the resources need.

#include "context.hpp"

#include <array>
#include <cstring>

using namespace fdw;

namespace {

// Reads the words of the commands; every read is checked.
class Reader {
public:
  Reader(const uint32_t *words, size_t count) : _words(words), _count(count) {}

  bool done() const { return _position >= _count; }

  uint32_t word() {
    if (_position >= _count) {
      _error = true;
      return 0;
    }
    return _words[_position++];
  }

  float real() {
    const uint32_t bits = word();
    float value;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
  }

  uint64_t wide() {
    const uint64_t low = word();
    const uint64_t high = word();
    return low | (high << 32);
  }

  bool failed() const { return _error; }

private:
  const uint32_t *_words;
  size_t _count;
  size_t _position = 0;
  bool _error = false;
};

// The state of the replay of a submission.
struct Replay {
  fdw_vk_context *context;
  VkCommandBuffer commands;
  Reader reader;
  // The size of the attachments of the render pass being recorded.
  uint32_t passWidth = 0;
  uint32_t passHeight = 0;
  bool inRenderPass = false;
  bool inComputePass = false;
  // The pipeline and the groups set, bound at the next draw.
  fdw_vk_pipeline *pipeline = nullptr;
  std::array<fdw_vk_group *, 8> groups{};
  std::array<bool, 8> dirty{};
};

template <typename T>
T *find(const std::map<uint32_t, T *> &objects, uint32_t id, const char *what,
        int *status) {
  const auto found = objects.find(id);
  if (found == objects.end()) {
    *status = fail(std::string("Unknown ") + what + " " + std::to_string(id));
    return nullptr;
  }
  return found->second;
}

// The default viewport and scissor of a render pass: the whole attachments,
// with a negative height so that y points up in clip space, as in WebGPU.
void setFullViewport(VkCommandBuffer commands, uint32_t width,
                     uint32_t height) {
  const VkViewport viewport{0,
                            static_cast<float>(height),
                            static_cast<float>(width),
                            -static_cast<float>(height),
                            0,
                            1};
  vkCmdSetViewport(commands, 0, 1, &viewport);
  const VkRect2D scissor{{0, 0}, {width, height}};
  vkCmdSetScissor(commands, 0, 1, &scissor);
}

bool isIntegerFormat(VkFormat format) {
  switch (format) {
  case VK_FORMAT_R8_UINT:
  case VK_FORMAT_R8G8_UINT:
  case VK_FORMAT_R8G8B8A8_UINT:
  case VK_FORMAT_R16_UINT:
  case VK_FORMAT_R16G16_UINT:
  case VK_FORMAT_R16G16B16A16_UINT:
  case VK_FORMAT_R32_UINT:
  case VK_FORMAT_R32G32_UINT:
  case VK_FORMAT_R32G32B32A32_UINT:
  case VK_FORMAT_R8_SINT:
  case VK_FORMAT_R8G8_SINT:
  case VK_FORMAT_R8G8B8A8_SINT:
  case VK_FORMAT_R16_SINT:
  case VK_FORMAT_R16G16_SINT:
  case VK_FORMAT_R16G16B16A16_SINT:
  case VK_FORMAT_R32_SINT:
  case VK_FORMAT_R32G32_SINT:
  case VK_FORMAT_R32G32B32A32_SINT:
    return true;
  default:
    return false;
  }
}

bool isSignedIntegerFormat(VkFormat format) {
  switch (format) {
  case VK_FORMAT_R8_SINT:
  case VK_FORMAT_R8G8_SINT:
  case VK_FORMAT_R8G8B8A8_SINT:
  case VK_FORMAT_R16_SINT:
  case VK_FORMAT_R16G16_SINT:
  case VK_FORMAT_R16G16B16A16_SINT:
  case VK_FORMAT_R32_SINT:
  case VK_FORMAT_R32G32_SINT:
  case VK_FORMAT_R32G32B32A32_SINT:
    return true;
  default:
    return false;
  }
}

// The operands of each command, to walk the commands of a pass ahead.
uint32_t operandCount(uint32_t opcode) {
  switch (opcode) {
  case FDW_VK_CMD_SET_PIPELINE:
    return 1;
  case FDW_VK_CMD_SET_GROUP:
  case FDW_VK_CMD_SET_VERTEX_BUFFER:
  case FDW_VK_CMD_SET_INDEX_BUFFER:
    return 2;
  case FDW_VK_CMD_DRAW:
  case FDW_VK_CMD_DRAW_INDEXED:
    return 3;
  case FDW_VK_CMD_SET_VIEWPORT:
    return 4;
  case FDW_VK_CMD_DISPATCH:
    return 3;
  case FDW_VK_CMD_DISPATCH_INDIRECT:
    return 3;
  default:
    return 0;
  }
}

// The barriers of the resources of a group, for shaders of `stages`,
// gathered into those of the pass.
int useGroup(Replay &replay, Barriers &barriers, const fdw_vk_group *group,
             VkPipelineStageFlags2 stages) {
  fdw_vk_context *context = replay.context;
  for (const auto &[kind, id] : group->resources) {
    if (kind == FDW_VK_BINDING_TEXTURE) {
      const auto texture = context->textures.find(id);
      if (texture == context->textures.end()) {
        return fail("A group uses the destroyed texture " + std::to_string(id));
      }
      useTexture(barriers, texture->second, VK_IMAGE_LAYOUT_READ_ONLY_OPTIMAL,
                 stages, VK_ACCESS_2_SHADER_SAMPLED_READ_BIT);
      continue;
    }
    const auto buffer = context->buffers.find(id);
    if (buffer == context->buffers.end()) {
      return fail("A group uses the destroyed buffer " + std::to_string(id));
    }
    useBuffer(barriers, buffer->second, stages,
              kind == FDW_VK_BINDING_UNIFORM ? VK_ACCESS_2_UNIFORM_READ_BIT
              : kind == FDW_VK_BINDING_STORAGE_READ
                  ? VK_ACCESS_2_SHADER_STORAGE_READ_BIT
                  : VK_ACCESS_2_SHADER_STORAGE_READ_BIT |
                        VK_ACCESS_2_SHADER_STORAGE_WRITE_BIT);
  }
  return 0;
}

// Before a render pass: the barriers of the resources its commands use,
// which cannot be placed inside it, gathered with those of its attachments.
// The commands are walked ahead, up to the end of the pass.
int prepareRenderPass(Replay &replay, Barriers &barriers) {
  constexpr VkPipelineStageFlags2 shaders =
      VK_PIPELINE_STAGE_2_VERTEX_SHADER_BIT |
      VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
  Reader ahead = replay.reader;
  int status = 0;
  while (!ahead.done()) {
    const uint32_t opcode = ahead.word();
    if (opcode == FDW_VK_CMD_END_RENDER_PASS) {
      return 0;
    }
    if (opcode == FDW_VK_CMD_SET_GROUP) {
      ahead.word();
      const fdw_vk_group *group =
          find(replay.context->groups, ahead.word(), "group", &status);
      if (!group || useGroup(replay, barriers, group, shaders) != 0) {
        return -1;
      }
    } else if (opcode == FDW_VK_CMD_SET_VERTEX_BUFFER ||
               opcode == FDW_VK_CMD_SET_INDEX_BUFFER) {
      const uint32_t first = ahead.word();
      const uint32_t second = ahead.word();
      const bool vertex = opcode == FDW_VK_CMD_SET_VERTEX_BUFFER;
      fdw_vk_buffer *buffer = find(replay.context->buffers,
                                   vertex ? second : first, "buffer", &status);
      if (!buffer) {
        return status;
      }
      useBuffer(barriers, buffer,
                vertex ? VK_PIPELINE_STAGE_2_VERTEX_ATTRIBUTE_INPUT_BIT
                       : VK_PIPELINE_STAGE_2_INDEX_INPUT_BIT,
                vertex ? VK_ACCESS_2_VERTEX_ATTRIBUTE_READ_BIT
                       : VK_ACCESS_2_INDEX_READ_BIT);
    } else {
      for (uint32_t i = operandCount(opcode); i > 0; i--) {
        ahead.word();
      }
    }
  }
  return 0;
}

// Binds the groups set since the last draw, with the layout of the
// pipeline.
int flushGroups(Replay &replay) {
  if (!replay.pipeline) {
    return fail("No pipeline set before drawing");
  }
  const std::vector<bool> &used = replay.pipeline->usedSets;
  for (uint32_t index = 0; index < replay.groups.size(); index++) {
    fdw_vk_group *group = replay.groups[index];
    // A set empty in this pipeline: what is bound there stays for the next.
    if (!replay.dirty[index] || !group || index >= used.size() ||
        !used[index]) {
      continue;
    }
    vkCmdBindDescriptorSets(replay.commands, replay.pipeline->bindPoint,
                            replay.pipeline->layout, index, 1, &group->set, 0,
                            nullptr);
    replay.dirty[index] = false;
  }
  return 0;
}

// A dispatch: the barriers of the groups bound and of the indirect buffer,
// in one call (a dispatch can read what the previous one wrote), then the
// groups and the dispatch.
int dispatch(Replay &replay, bool indirect) {
  int status = 0;
  Reader &reader = replay.reader;
  uint32_t x = 0, y = 0, z = 0;
  fdw_vk_buffer *buffer = nullptr;
  uint64_t offset = 0;
  if (indirect) {
    buffer = find(replay.context->buffers, reader.word(), "buffer", &status);
    offset = reader.wide();
    if (!buffer) {
      return status;
    }
  } else {
    x = reader.word();
    y = reader.word();
    z = reader.word();
  }
  if (!replay.pipeline ||
      replay.pipeline->bindPoint != VK_PIPELINE_BIND_POINT_COMPUTE) {
    return fail("No compute pipeline set before dispatching");
  }
  Barriers barriers{replay.commands};
  for (fdw_vk_group *group : replay.groups) {
    if (group && useGroup(replay, barriers, group,
                          VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT) != 0) {
      return -1;
    }
  }
  if (buffer) {
    useBuffer(barriers, buffer, VK_PIPELINE_STAGE_2_DRAW_INDIRECT_BIT,
              VK_ACCESS_2_INDIRECT_COMMAND_READ_BIT);
  }
  barriers.place();
  if (flushGroups(replay) != 0) {
    return -1;
  }
  if (buffer) {
    vkCmdDispatchIndirect(replay.commands, buffer->buffer, offset);
  } else {
    vkCmdDispatch(replay.commands, x, y, z);
  }
  return 0;
}

int drawCommand(Replay &replay, uint32_t opcode) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_vk_context *context = replay.context;
  switch (opcode) {
  case FDW_VK_CMD_SET_PIPELINE: {
    fdw_vk_pipeline *pipeline =
        find(context->pipelines, reader.word(), "pipeline", &status);
    if (!pipeline) {
      return status;
    }
    vkCmdBindPipeline(replay.commands, pipeline->bindPoint, pipeline->pipeline);
    replay.pipeline = pipeline;
    // Rebound with the layout of this pipeline.
    replay.dirty.fill(true);
    return 0;
  }
  case FDW_VK_CMD_SET_GROUP: {
    const uint32_t index = reader.word();
    fdw_vk_group *group = find(context->groups, reader.word(), "group", &status);
    if (!group) {
      return status;
    }
    if (index >= replay.groups.size()) {
      return fail("Group index " + std::to_string(index) + " out of range");
    }
    replay.groups[index] = group;
    replay.dirty[index] = true;
    return 0;
  }
  case FDW_VK_CMD_SET_VERTEX_BUFFER: {
    const uint32_t slot = reader.word();
    fdw_vk_buffer *buffer =
        find(context->buffers, reader.word(), "buffer", &status);
    if (!buffer) {
      return status;
    }
    const VkDeviceSize offset = 0;
    vkCmdBindVertexBuffers(replay.commands, slot, 1, &buffer->buffer, &offset);
    return 0;
  }
  case FDW_VK_CMD_SET_INDEX_BUFFER: {
    fdw_vk_buffer *buffer =
        find(context->buffers, reader.word(), "buffer", &status);
    const uint32_t format = reader.word();
    if (!buffer) {
      return status;
    }
    vkCmdBindIndexBuffer(replay.commands, buffer->buffer, 0,
                         format == 0 ? VK_INDEX_TYPE_UINT16
                                     : VK_INDEX_TYPE_UINT32);
    return 0;
  }
  case FDW_VK_CMD_DISPATCH:
  case FDW_VK_CMD_DISPATCH_INDIRECT:
    if (!replay.inComputePass) {
      return fail("A dispatch outside of a compute pass");
    }
    return dispatch(replay, opcode == FDW_VK_CMD_DISPATCH_INDIRECT);
  case FDW_VK_CMD_DRAW:
  case FDW_VK_CMD_DRAW_INDEXED: {
    if (!replay.inRenderPass) {
      return fail("A draw outside of a render pass");
    }
    const uint32_t count = reader.word();
    const uint32_t instances = reader.word();
    const uint32_t firstInstance = reader.word();
    if (flushGroups(replay) != 0) {
      return -1;
    }
    if (opcode == FDW_VK_CMD_DRAW) {
      vkCmdDraw(replay.commands, count, instances, 0, firstInstance);
    } else {
      vkCmdDrawIndexed(replay.commands, count, instances, 0, 0, firstInstance);
    }
    return 0;
  }
  case FDW_VK_CMD_SET_VIEWPORT: {
    const float x = reader.real();
    const float y = reader.real();
    const float width = reader.real();
    const float height = reader.real();
    // From the top left corner; the height is negative, as for the whole
    // attachments.
    const VkViewport viewport{x, y + height, width, -height, 0, 1};
    vkCmdSetViewport(replay.commands, 0, 1, &viewport);
    const VkRect2D scissor{
        {static_cast<int32_t>(x), static_cast<int32_t>(y)},
        {static_cast<uint32_t>(width), static_cast<uint32_t>(height)}};
    vkCmdSetScissor(replay.commands, 0, 1, &scissor);
    return 0;
  }
  default:
    return fail("Unknown command " + std::to_string(opcode));
  }
}

int beginRenderPass(Replay &replay) {
  int status = 0;
  fdw_vk_context *context = replay.context;
  Reader &reader = replay.reader;
  const uint32_t colorCount = reader.word();
  if (colorCount > context->maxColorAttachments) {
    return fail("Too many color attachments");
  }
  // The barriers of the pass, placed together before it.
  Barriers barriers{replay.commands};
  std::vector<VkRenderingAttachmentInfo> colors(colorCount);
  uint32_t width = 0;
  uint32_t height = 0;
  for (uint32_t i = 0; i < colorCount; i++) {
    fdw_vk_texture *target =
        find(context->textures, reader.word(), "color target", &status);
    const bool clear = reader.word() == 0;
    VkClearValue value{};
    for (float &component : value.color.float32) {
      component = reader.real();
    }
    const uint32_t resolveId = reader.word();
    if (!target) {
      return status;
    }
    // Integer formats take integer clear values.
    if (isIntegerFormat(target->format)) {
      const bool sint = isSignedIntegerFormat(target->format);
      for (int c = 0; c < 4; c++) {
        const float component = value.color.float32[c];
        if (sint) {
          value.color.int32[c] = static_cast<int32_t>(component);
        } else {
          value.color.uint32[c] = static_cast<uint32_t>(component);
        }
      }
    }
    useTexture(barriers, target, VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL,
               VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
               VK_ACCESS_2_COLOR_ATTACHMENT_READ_BIT |
                   VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT,
               clear);
    VkRenderingAttachmentInfo &color = colors[i];
    color = {VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO};
    color.imageView = target->attachmentView;
    color.imageLayout = VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL;
    color.loadOp = clear ? VK_ATTACHMENT_LOAD_OP_CLEAR : VK_ATTACHMENT_LOAD_OP_LOAD;
    color.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    color.clearValue = value;
    if (resolveId != 0) {
      fdw_vk_texture *resolve =
          find(context->textures, resolveId, "resolve target", &status);
      if (!resolve) {
        return status;
      }
      // Entirely written by the resolve.
      useTexture(barriers, resolve, VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL,
                 VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
                 VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT, true);
      color.resolveMode = isIntegerFormat(target->format)
                              ? VK_RESOLVE_MODE_SAMPLE_ZERO_BIT
                              : VK_RESOLVE_MODE_AVERAGE_BIT;
      color.resolveImageView = resolve->attachmentView;
      color.resolveImageLayout = VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL;
    }
    width = target->width;
    height = target->height;
  }

  VkRenderingAttachmentInfo depth{VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO};
  bool hasDepth = false;
  bool hasStencil = false;
  const uint32_t depthId = reader.word();
  const bool clearDepth = reader.word() == 0;
  const float depthValue = reader.real();
  if (depthId != 0) {
    fdw_vk_texture *target =
        find(context->textures, depthId, "depth target", &status);
    if (!target) {
      return status;
    }
    useTexture(barriers, target, VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL,
               VK_PIPELINE_STAGE_2_EARLY_FRAGMENT_TESTS_BIT |
                   VK_PIPELINE_STAGE_2_LATE_FRAGMENT_TESTS_BIT,
               VK_ACCESS_2_DEPTH_STENCIL_ATTACHMENT_READ_BIT |
                   VK_ACCESS_2_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT,
               clearDepth);
    depth.imageView = target->attachmentView;
    depth.imageLayout = VK_IMAGE_LAYOUT_ATTACHMENT_OPTIMAL;
    depth.loadOp =
        clearDepth ? VK_ATTACHMENT_LOAD_OP_CLEAR : VK_ATTACHMENT_LOAD_OP_LOAD;
    depth.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    depth.clearValue.depthStencil = {depthValue, 0};
    hasDepth = true;
    hasStencil = (target->aspect & VK_IMAGE_ASPECT_STENCIL_BIT) != 0;
    if (colorCount == 0) {
      width = target->width;
      height = target->height;
    }
  }
  if (reader.failed()) {
    return fail("Truncated render pass command");
  }
  if (prepareRenderPass(replay, barriers) != 0) {
    return -1;
  }
  barriers.place();

  VkRenderingInfo info{VK_STRUCTURE_TYPE_RENDERING_INFO};
  info.renderArea = {{0, 0}, {width, height}};
  info.layerCount = 1;
  info.colorAttachmentCount = colorCount;
  info.pColorAttachments = colors.data();
  info.pDepthAttachment = hasDepth ? &depth : nullptr;
  info.pStencilAttachment = hasStencil ? &depth : nullptr;
  vkCmdBeginRendering(replay.commands, &info);
  setFullViewport(replay.commands, width, height);
  replay.passWidth = width;
  replay.passHeight = height;
  replay.inRenderPass = true;
  return 0;
}

int copyBuffer(Replay &replay) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_vk_buffer *source =
      find(replay.context->buffers, reader.word(), "buffer", &status);
  const uint64_t sourceOffset = reader.wide();
  fdw_vk_buffer *destination =
      find(replay.context->buffers, reader.word(), "buffer", &status);
  const uint64_t destinationOffset = reader.wide();
  const uint64_t size = reader.wide();
  if (!source || !destination) {
    return status;
  }
  // Both barriers in one call.
  Barriers barriers{replay.commands};
  useBuffer(barriers, source, VK_PIPELINE_STAGE_2_COPY_BIT,
            VK_ACCESS_2_TRANSFER_READ_BIT);
  useBuffer(barriers, destination, VK_PIPELINE_STAGE_2_COPY_BIT,
            VK_ACCESS_2_TRANSFER_WRITE_BIT);
  barriers.place();
  const VkBufferCopy region{sourceOffset, destinationOffset, size};
  vkCmdCopyBuffer(replay.commands, source->buffer, destination->buffer, 1,
                  &region);
  return 0;
}

int copyTexture(Replay &replay) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_vk_texture *source =
      find(replay.context->textures, reader.word(), "texture", &status);
  fdw_vk_texture *destination =
      find(replay.context->textures, reader.word(), "texture", &status);
  const uint32_t width = reader.word();
  const uint32_t height = reader.word();
  if (!source || !destination) {
    return status;
  }
  // Both barriers in one call.
  Barriers barriers{replay.commands};
  useTexture(barriers, source, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
             VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_READ_BIT);
  useTexture(barriers, destination, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
             VK_PIPELINE_STAGE_2_COPY_BIT, VK_ACCESS_2_TRANSFER_WRITE_BIT);
  barriers.place();
  VkImageCopy region{};
  region.srcSubresource = {source->aspect, 0, 0, 1};
  region.dstSubresource = {destination->aspect, 0, 0, 1};
  region.extent = {width, height, 1};
  vkCmdCopyImage(replay.commands, source->image,
                 VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, destination->image,
                 VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
  return 0;
}

// Resets timestamp queries, or writes one: the time when the commands
// before it are complete.
int queryCommand(Replay &replay, uint32_t opcode) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_vk_query_pool *pool =
      find(replay.context->queryPools, reader.word(), "query pool", &status);
  const uint32_t first = reader.word();
  const uint32_t count =
      opcode == FDW_VK_CMD_RESET_QUERIES ? reader.word() : 1;
  if (!pool) {
    return status;
  }
  if (first + count > pool->count) {
    return fail("Queries out of the pool");
  }
  if (opcode == FDW_VK_CMD_RESET_QUERIES) {
    vkCmdResetQueryPool(replay.commands, pool->pool, first, count);
  } else {
    vkCmdWriteTimestamp2(replay.commands,
                         VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, pool->pool,
                         first);
  }
  return 0;
}

int replayCommands(Replay &replay) {
  while (!replay.reader.done()) {
    const uint32_t opcode = replay.reader.word();
    int status = 0;
    switch (opcode) {
    case FDW_VK_CMD_BEGIN_RENDER_PASS:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("A pass is already open");
      }
      status = beginRenderPass(replay);
      break;
    case FDW_VK_CMD_END_RENDER_PASS:
      if (!replay.inRenderPass) {
        return fail("No render pass to end");
      }
      vkCmdEndRendering(replay.commands);
      replay.inRenderPass = false;
      break;
    case FDW_VK_CMD_BEGIN_COMPUTE_PASS:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("A pass is already open");
      }
      replay.inComputePass = true;
      break;
    case FDW_VK_CMD_END_COMPUTE_PASS:
      if (!replay.inComputePass) {
        return fail("No compute pass to end");
      }
      replay.inComputePass = false;
      break;
    case FDW_VK_CMD_RESET_QUERIES:
    case FDW_VK_CMD_WRITE_TIMESTAMP:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("Timestamps are outside of the passes");
      }
      status = queryCommand(replay, opcode);
      break;
    case FDW_VK_CMD_COPY_BUFFER:
      status = copyBuffer(replay);
      break;
    case FDW_VK_CMD_COPY_TEXTURE:
      status = copyTexture(replay);
      break;
    case FDW_VK_CMD_GENERATE_MIPMAPS: {
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("Mipmaps are computed outside of the passes");
      }
      fdw_vk_texture *texture = find(replay.context->textures,
                                     replay.reader.word(), "texture", &status);
      if (texture) {
        status = generateMipmaps(replay.context, replay.commands, texture);
      }
      break;
    }
    default:
      if (!replay.inRenderPass && !replay.inComputePass) {
        return fail("Command " + std::to_string(opcode) +
                    " outside of a pass");
      }
      status = drawCommand(replay, opcode);
    }
    if (status != 0) {
      return status;
    }
    if (replay.reader.failed()) {
      return fail("Truncated command " + std::to_string(opcode));
    }
  }
  if (replay.inRenderPass || replay.inComputePass) {
    return fail("A pass was not ended");
  }
  return 0;
}

} // namespace

extern "C" {

int fdw_vk_submit(fdw_vk_context *context, const uint32_t *words,
                  size_t count) {
  VkCommandBuffer commands = VK_NULL_HANDLE;
  VkCommandBufferAllocateInfo allocate{
      VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  allocate.commandPool = context->commandPool;
  allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  allocate.commandBufferCount = 1;
  VkResult result =
      vkAllocateCommandBuffers(context->device, &allocate, &commands);
  if (result != VK_SUCCESS) {
    return fail("vkAllocateCommandBuffers", result);
  }
  VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  vkBeginCommandBuffer(commands, &begin);
  Replay replay{context, commands, Reader(words, count)};
  const int status = replayCommands(replay);
  // On error, what was recorded is still submitted, a render pass left open
  // closed: the tracked state of the resources is that of the commands
  // recorded, which must then run.
  if (replay.inRenderPass) {
    vkCmdEndRendering(commands);
  }
  vkEndCommandBuffer(commands);
  VkDevice device = context->device;
  VkCommandPool pool = context->commandPool;
  const std::string error = status != 0 ? fdw_vk_last_error() : "";
  const uint64_t submission = submit(context, {commands});
  if (submission == 0) {
    vkFreeCommandBuffers(device, pool, 1, &commands);
    return -1;
  }
  context->deferred.push_back({submission, [device, pool, commands] {
                                 vkFreeCommandBuffers(device, pool, 1,
                                                      &commands);
                               }});
  collect(context);
  return status != 0 ? fail(error) : 0;
}

} // extern "C"
