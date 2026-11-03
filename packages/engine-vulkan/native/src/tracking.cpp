// The tracking of the resources: the barriers between their uses, as
// WebGPU implementations do (option A of design/native-backends.md, §8.1).

#include "context.hpp"

#include <algorithm>

namespace fdw {

bool writes(VkAccessFlags2 access) {
  constexpr VkAccessFlags2 writeBits =
      VK_ACCESS_2_SHADER_WRITE_BIT | VK_ACCESS_2_SHADER_STORAGE_WRITE_BIT |
      VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT |
      VK_ACCESS_2_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT |
      VK_ACCESS_2_TRANSFER_WRITE_BIT | VK_ACCESS_2_HOST_WRITE_BIT |
      VK_ACCESS_2_MEMORY_WRITE_BIT |
      VK_ACCESS_2_ACCELERATION_STRUCTURE_WRITE_BIT_KHR;
  return (access & writeBits) != 0;
}

namespace {

// The index of the barrier of a resource in the gathered ones, or -1.
template <typename T>
ptrdiff_t pending(const std::vector<T *> &resources, const T *resource) {
  const auto found = std::find(resources.begin(), resources.end(), resource);
  return found == resources.end() ? -1 : found - resources.begin();
}

// Whether a use needs no barrier: a read, after no write, or in stages and
// accesses that already wait for the last write. A read waiting only for
// the previous reads would not wait for the write (a copy, a uniform read
// in a fragment shader, then a storage read in a compute one).
bool synchronised(const Access &last, VkPipelineStageFlags2 stages,
                  VkAccessFlags2 access) {
  if (writes(access)) {
    return false;
  }
  if (last.write.stages == VK_PIPELINE_STAGE_2_NONE &&
      last.write.access == VK_ACCESS_2_NONE) {
    return true;
  }
  return (stages & ~last.synced.stages) == 0 &&
         (access & ~last.synced.access) == 0;
}

// A use without barrier: the next write waits for it too.
void add(Access &last, VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  last.stages |= stages;
  last.access |= access;
}

// A use joining a barrier gathered for the same pass. The reads joining the
// barrier of a write do not wait for it (the same pass).
void join(Access &last, VkPipelineStageFlags2 stages, VkAccessFlags2 access,
          bool barrierWrites) {
  add(last, stages, access);
  if (writes(access)) {
    last.write.stages |= stages;
    last.write.access |= access;
    last.synced = {};
  } else if (!barrierWrites) {
    last.synced.stages |= stages;
    last.synced.access |= access;
  }
}

// A use after its barrier (from every use before): a write, or a read that
// waits for everything before it; the next reads in other stages wait for
// this barrier.
Access after(VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  if (writes(access)) {
    return {stages, access};
  }
  Access last{stages, access};
  last.write = {stages, VK_ACCESS_2_NONE};
  last.synced = {stages, access};
  return last;
}

} // namespace

void Barriers::place() {
  if (images.empty() && bufferBarriers.empty() && memory.empty()) {
    return;
  }
  for (size_t i = 0; i < images.size(); i++) {
    if (discards[i]) {
      images[i].oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    }
  }
  VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
  dependency.imageMemoryBarrierCount = static_cast<uint32_t>(images.size());
  dependency.pImageMemoryBarriers = images.data();
  dependency.bufferMemoryBarrierCount =
      static_cast<uint32_t>(bufferBarriers.size());
  dependency.pBufferMemoryBarriers = bufferBarriers.data();
  dependency.memoryBarrierCount = static_cast<uint32_t>(memory.size());
  dependency.pMemoryBarriers = memory.data();
  vkCmdPipelineBarrier2(commands, &dependency);
  images.clear();
  textures.clear();
  discards.clear();
  bufferBarriers.clear();
  buffers.clear();
  memory.clear();
  tops.clear();
}

void recordLayout(fdw_vk_texture *texture) {
  const uint64_t next = *texture->submitted + 1;
  if (texture->recordedFor != next) {
    texture->recordedFor = next;
    texture->submittedLayout = texture->layout;
  }
}

void restoreLayouts(fdw_vk_context *context) {
  const uint64_t next = context->submitted + 1;
  for (const auto &[id, texture] : context->textures) {
    if (texture->recordedFor == next) {
      texture->layout = texture->submittedLayout;
      texture->recordedFor = 0;
    }
  }
}

void useTexture(Barriers &barriers, fdw_vk_texture *texture,
                VkImageLayout layout, VkPipelineStageFlags2 stages,
                VkAccessFlags2 access, bool discard) {
  // Already a barrier for the texture, to the same layout: this use waits
  // with the others of the pass. The content is kept if a use needs it.
  const ptrdiff_t index = pending(barriers.textures, texture);
  if (index >= 0 && barriers.images[index].newLayout == layout) {
    const bool barrierWrites = writes(barriers.images[index].dstAccessMask);
    barriers.images[index].dstStageMask |= stages;
    barriers.images[index].dstAccessMask |= access;
    barriers.discards[index] = barriers.discards[index] && discard;
    join(texture->last, stages, access, barrierWrites);
    return;
  }
  // To another layout: after the transition gathered.
  if (index >= 0) {
    barriers.place();
  }
  // Reads after reads, in the same layout, need no barrier once they wait
  // for the last write: the next write will wait for all of them.
  if (texture->layout == layout &&
      synchronised(texture->last, stages, access)) {
    add(texture->last, stages, access);
    return;
  }
  VkImageMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2};
  barrier.srcStageMask = texture->last.stages;
  barrier.srcAccessMask = texture->last.access;
  barrier.dstStageMask = stages;
  barrier.dstAccessMask = access;
  barrier.oldLayout = texture->layout;
  barrier.newLayout = layout;
  barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  barrier.image = texture->image;
  barrier.subresourceRange = {texture->aspect, 0, VK_REMAINING_MIP_LEVELS, 0,
                              VK_REMAINING_ARRAY_LAYERS};
  barriers.images.push_back(barrier);
  barriers.textures.push_back(texture);
  barriers.discards.push_back(discard);
  recordLayout(texture);
  texture->layout = layout;
  texture->last = after(stages, access);
}

void useBuffer(Barriers &barriers, fdw_vk_buffer *buffer,
               VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  const ptrdiff_t index = pending(barriers.buffers, buffer);
  if (index >= 0) {
    const bool barrierWrites = writes(barriers.bufferBarriers[index].dstAccessMask);
    barriers.bufferBarriers[index].dstStageMask |= stages;
    barriers.bufferBarriers[index].dstAccessMask |= access;
    join(buffer->last, stages, access, barrierWrites);
    return;
  }
  if (synchronised(buffer->last, stages, access)) {
    add(buffer->last, stages, access);
    return;
  }
  // Never used: nothing to wait for.
  if (buffer->last.stages != VK_PIPELINE_STAGE_2_NONE) {
    VkBufferMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER_2};
    barrier.srcStageMask = buffer->last.stages;
    barrier.srcAccessMask = buffer->last.access;
    barrier.dstStageMask = stages;
    barrier.dstAccessMask = access;
    barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.buffer = buffer->buffer;
    barrier.offset = 0;
    barrier.size = VK_WHOLE_SIZE;
    barriers.bufferBarriers.push_back(barrier);
    barriers.buffers.push_back(buffer);
  }
  buffer->last = after(stages, access);
}

void useTopLevel(Barriers &barriers, fdw_vk_top_level *top,
                 VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  const ptrdiff_t index = pending(barriers.tops, top);
  if (index >= 0) {
    const bool barrierWrites = writes(barriers.memory[index].dstAccessMask);
    barriers.memory[index].dstStageMask |= stages;
    barriers.memory[index].dstAccessMask |= access;
    join(top->last, stages, access, barrierWrites);
    return;
  }
  if (synchronised(top->last, stages, access)) {
    add(top->last, stages, access);
    return;
  }
  if (top->last.stages != VK_PIPELINE_STAGE_2_NONE) {
    VkMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER_2};
    barrier.srcStageMask = top->last.stages;
    barrier.srcAccessMask = top->last.access;
    barrier.dstStageMask = stages;
    barrier.dstAccessMask = access;
    barriers.memory.push_back(barrier);
    barriers.tops.push_back(top);
  }
  top->last = after(stages, access);
}

void useTexture(VkCommandBuffer commands, fdw_vk_texture *texture,
                VkImageLayout layout, VkPipelineStageFlags2 stages,
                VkAccessFlags2 access, bool discard) {
  Barriers barriers{commands};
  useTexture(barriers, texture, layout, stages, access, discard);
}

void useBuffer(VkCommandBuffer commands, fdw_vk_buffer *buffer,
               VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  Barriers barriers{commands};
  useBuffer(barriers, buffer, stages, access);
}

uint64_t addRead(fdw_vk_context *context, uint64_t submission,
                 const HostBuffer &readback, uint64_t size) {
  const uint64_t ticket = context->nextTicket++;
  context->reads[ticket] = {submission, readback.buffer, readback.allocation,
                            size};
  return ticket;
}

} // namespace fdw
