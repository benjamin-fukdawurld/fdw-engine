// Timestamp queries (include/fdw/vulkan.h): pools of timestamps, written
// and reset by the commands, read without waiting.

#include "context.hpp"

#include <cstdint>
#include <vector>

using namespace fdw;

extern "C" {

int fdw_vk_timestamps_supported(const fdw_vk_context *context) {
  return context->timestampValidBits > 0 && context->timestampPeriod > 0 ? 1
                                                                         : 0;
}

fdw_vk_query_pool *fdw_vk_query_pool_create(fdw_vk_context *context,
                                            uint32_t count) {
  if (!fdw_vk_timestamps_supported(context)) {
    fail("The queue does not write timestamps");
    return nullptr;
  }
  VkQueryPoolCreateInfo info{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
  info.queryType = VK_QUERY_TYPE_TIMESTAMP;
  info.queryCount = count;
  VkQueryPool pool = VK_NULL_HANDLE;
  if (vkCreateQueryPool(context->device, &info, nullptr, &pool) !=
      VK_SUCCESS) {
    fail("vkCreateQueryPool failed");
    return nullptr;
  }
  auto *result = new fdw_vk_query_pool{context->nextId++, pool, count};
  context->queryPools[result->id] = result;
  return result;
}

void fdw_vk_query_pool_destroy(fdw_vk_context *context,
                               fdw_vk_query_pool *pool) {
  if (!pool || !context->queryPools.erase(pool->id)) {
    return;
  }
  VkDevice device = context->device;
  defer(context, [device, pool] {
    vkDestroyQueryPool(device, pool->pool, nullptr);
    delete pool;
  });
}

uint32_t fdw_vk_query_pool_id(const fdw_vk_query_pool *pool) {
  return pool->id;
}

int fdw_vk_query_pool_read(fdw_vk_context *context, fdw_vk_query_pool *pool,
                           uint32_t first, uint32_t count,
                           double *nanoseconds) {
  if (first + count > pool->count) {
    return fail("Queries out of the pool");
  }
  if (count == 0) {
    return 1;
  }
  // Each query: its value, then whether it is available.
  std::vector<uint64_t> values(count * 2);
  const VkResult result = vkGetQueryPoolResults(
      context->device, pool->pool, first, count,
      values.size() * sizeof(uint64_t), values.data(), 2 * sizeof(uint64_t),
      VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
  if (result != VK_SUCCESS && result != VK_NOT_READY) {
    return fail("vkGetQueryPoolResults failed");
  }
  const uint64_t mask = context->timestampValidBits >= 64
                            ? ~uint64_t{0}
                            : (uint64_t{1} << context->timestampValidBits) - 1;
  for (uint32_t i = 0; i < count; i++) {
    if (values[i * 2 + 1] == 0) {
      return 0;
    }
    nanoseconds[i] =
        static_cast<double>(values[i * 2] & mask) * context->timestampPeriod;
  }
  return 1;
}

} // extern "C"
