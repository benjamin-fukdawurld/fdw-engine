// The tracking of the resources: the barriers between their uses, as
// WebGPU implementations do (option A of design/native-backends.md, §8.1).

#include "context.hpp"

namespace fdw {

bool writes(VkAccessFlags2 access) {
  constexpr VkAccessFlags2 writeBits =
      VK_ACCESS_2_SHADER_WRITE_BIT | VK_ACCESS_2_SHADER_STORAGE_WRITE_BIT |
      VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT |
      VK_ACCESS_2_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT |
      VK_ACCESS_2_TRANSFER_WRITE_BIT | VK_ACCESS_2_HOST_WRITE_BIT |
      VK_ACCESS_2_MEMORY_WRITE_BIT;
  return (access & writeBits) != 0;
}

void useTexture(VkCommandBuffer commands, fdw_vk_texture *texture,
                VkImageLayout layout, VkPipelineStageFlags2 stages,
                VkAccessFlags2 access, bool discard) {
  // Reads after reads, in the same layout, need no barrier: the next write
  // will wait for all of them.
  if (texture->layout == layout && !writes(texture->last.access) &&
      !writes(access)) {
    texture->last.stages |= stages;
    texture->last.access |= access;
    return;
  }
  VkImageMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2};
  barrier.srcStageMask = texture->last.stages;
  barrier.srcAccessMask = texture->last.access;
  barrier.dstStageMask = stages;
  barrier.dstAccessMask = access;
  barrier.oldLayout = discard ? VK_IMAGE_LAYOUT_UNDEFINED : texture->layout;
  barrier.newLayout = layout;
  barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
  barrier.image = texture->image;
  barrier.subresourceRange = {texture->aspect, 0, VK_REMAINING_MIP_LEVELS, 0,
                              VK_REMAINING_ARRAY_LAYERS};
  VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
  dependency.imageMemoryBarrierCount = 1;
  dependency.pImageMemoryBarriers = &barrier;
  vkCmdPipelineBarrier2(commands, &dependency);
  texture->layout = layout;
  texture->last = {stages, access};
}

void useBuffer(VkCommandBuffer commands, fdw_vk_buffer *buffer,
               VkPipelineStageFlags2 stages, VkAccessFlags2 access) {
  if (!writes(buffer->last.access) && !writes(access)) {
    buffer->last.stages |= stages;
    buffer->last.access |= access;
    return;
  }
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
    VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
    dependency.bufferMemoryBarrierCount = 1;
    dependency.pBufferMemoryBarriers = &barrier;
    vkCmdPipelineBarrier2(commands, &dependency);
  }
  buffer->last = {stages, access};
}

uint64_t addRead(fdw_vk_context *context, uint64_t submission,
                 const HostBuffer &readback, uint64_t size) {
  const uint64_t ticket = context->nextTicket++;
  context->reads[ticket] = {submission, readback.buffer, readback.allocation,
                            size};
  return ticket;
}

} // namespace fdw
