// Buffers: creation, writes through staging buffers, reads back.

#include "context.hpp"

#include <cstring>

using namespace fdw;

namespace {

VkBufferUsageFlags bufferUsage(uint32_t usage) {
  // Every buffer can be written and read back.
  VkBufferUsageFlags flags =
      VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
  if (usage & FDW_VK_BUFFER_UNIFORM) {
    flags |= VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT;
  }
  if (usage & FDW_VK_BUFFER_STORAGE) {
    flags |= VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
  }
  if (usage & FDW_VK_BUFFER_VERTEX) {
    flags |= VK_BUFFER_USAGE_VERTEX_BUFFER_BIT;
  }
  if (usage & FDW_VK_BUFFER_INDEX) {
    flags |= VK_BUFFER_USAGE_INDEX_BUFFER_BIT;
  }
  if (usage & FDW_VK_BUFFER_INDIRECT) {
    flags |= VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT;
  }
  return flags;
}

// The copies of the transfer command buffer run in order: each one after
// the previous ones (they may touch the same bytes).
void afterPreviousTransfers(VkCommandBuffer commands) {
  memoryBarrier(commands, VK_PIPELINE_STAGE_2_ALL_TRANSFER_BIT,
                VK_ACCESS_2_TRANSFER_WRITE_BIT,
                VK_PIPELINE_STAGE_2_ALL_TRANSFER_BIT,
                VK_ACCESS_2_TRANSFER_READ_BIT | VK_ACCESS_2_TRANSFER_WRITE_BIT);
}

int checkRange(const fdw_vk_buffer *buffer, uint64_t offset, uint64_t size) {
  if (offset + size > buffer->size || offset + size < offset) {
    return fail("The range " + std::to_string(offset) + " + " +
                std::to_string(size) + " is outside of the buffer (" +
                std::to_string(buffer->size) + " bytes)");
  }
  return 0;
}

} // namespace

extern "C" {

uint32_t fdw_vk_buffer_id(const fdw_vk_buffer *buffer) { return buffer->id; }

fdw_vk_buffer *fdw_vk_buffer_create(fdw_vk_context *context, uint64_t size,
                                    uint32_t usage, const char *label) {
  VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  // Vulkan forbids empty buffers.
  info.size = size > 0 ? size : 4;
  info.usage = bufferUsage(usage);
  VmaAllocationCreateInfo allocation{};
  allocation.usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE;
  auto *buffer = new fdw_vk_buffer();
  buffer->size = size;
  const VkResult result =
      vmaCreateBuffer(context->allocator, &info, &allocation, &buffer->buffer,
                      &buffer->allocation, nullptr);
  if (result != VK_SUCCESS) {
    delete buffer;
    fail("vmaCreateBuffer", result);
    return nullptr;
  }
  setName(context, VK_OBJECT_TYPE_BUFFER,
          reinterpret_cast<uint64_t>(buffer->buffer), label);
  // Zeroed, as in WebGPU: the memory may hold what a destroyed buffer left.
  // Recorded with the transfers, which run before the next submission.
  VkCommandBuffer commands = transfers(context);
  afterPreviousTransfers(commands);
  vkCmdFillBuffer(commands, buffer->buffer, 0, VK_WHOLE_SIZE, 0);
  buffer->id = context->nextId++;
  context->buffers[buffer->id] = buffer;
  return buffer;
}

void fdw_vk_buffer_destroy(fdw_vk_context *context, fdw_vk_buffer *buffer) {
  if (!buffer || !context->buffers.erase(buffer->id)) {
    return;
  }
  VmaAllocator allocator = context->allocator;
  defer(context, [allocator, buffer] {
    vmaDestroyBuffer(allocator, buffer->buffer, buffer->allocation);
    delete buffer;
  });
}

int fdw_vk_buffer_write(fdw_vk_context *context, fdw_vk_buffer *buffer,
                        uint64_t offset, const void *data, uint64_t size) {
  if (size == 0) {
    return 0;
  }
  if (checkRange(buffer, offset, size) != 0) {
    return -1;
  }
  HostBuffer staging;
  if (createHostBuffer(context, size, false, &staging) != 0) {
    return -1;
  }
  std::memcpy(staging.mapped, data, size);
  vmaFlushAllocation(context->allocator, staging.allocation, 0, size);

  VkCommandBuffer commands = transfers(context);
  afterPreviousTransfers(commands);
  VkBufferCopy region{0, offset, size};
  vkCmdCopyBuffer(commands, staging.buffer, buffer->buffer, 1, &region);
  // The barriers at the ends of the transfers order this write with the
  // commands before and after.
  buffer->last = {};
  VmaAllocator allocator = context->allocator;
  defer(context, [allocator, staging] {
    vmaDestroyBuffer(allocator, staging.buffer, staging.allocation);
  });
  return 0;
}

int fdw_vk_buffer_read(fdw_vk_context *context, fdw_vk_buffer *buffer,
                       uint64_t offset, uint64_t size, uint64_t *ticket) {
  if (checkRange(buffer, offset, size) != 0) {
    return -1;
  }
  HostBuffer readback;
  if (createHostBuffer(context, size > 0 ? size : 4, true, &readback) != 0) {
    return -1;
  }
  VkCommandBuffer commands = transfers(context);
  afterPreviousTransfers(commands);
  if (size > 0) {
    VkBufferCopy region{offset, 0, size};
    vkCmdCopyBuffer(commands, buffer->buffer, readback.buffer, 1, &region);
  }
  // The CPU reads the copy once the submission is done.
  memoryBarrier(commands, VK_PIPELINE_STAGE_2_ALL_TRANSFER_BIT,
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

int fdw_vk_read_ready(fdw_vk_context *context, uint64_t ticket) {
  const auto found = context->reads.find(ticket);
  if (found == context->reads.end()) {
    return fail("Unknown read ticket " + std::to_string(ticket));
  }
  collect(context);
  return completed(context) >= found->second.submission ? 1 : 0;
}

int fdw_vk_read_take(fdw_vk_context *context, uint64_t ticket, void *data,
                     uint64_t size) {
  const auto found = context->reads.find(ticket);
  if (found == context->reads.end()) {
    return fail("Unknown read ticket " + std::to_string(ticket));
  }
  PendingRead read = found->second;
  if (completed(context) < read.submission) {
    return fail("The read is not ready");
  }
  if (size > read.size) {
    return fail("The read has only " + std::to_string(read.size) + " bytes");
  }
  vmaInvalidateAllocation(context->allocator, read.allocation, 0, read.size);
  VmaAllocationInfo info{};
  vmaGetAllocationInfo(context->allocator, read.allocation, &info);
  std::memcpy(data, info.pMappedData, size);
  vmaDestroyBuffer(context->allocator, read.readback, read.allocation);
  context->reads.erase(found);
  return 0;
}

} // extern "C"
