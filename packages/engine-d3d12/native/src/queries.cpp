// Timestamp queries: each one is resolved into a read back buffer as soon
// as it is written, and read once its submission is complete.

#include "context.hpp"

using namespace fdw;

extern "C" {

int fdw_dx_timestamps_supported(const fdw_dx_context *context) {
  return context->timestampFrequency > 0 ? 1 : 0;
}

fdw_dx_query_pool *fdw_dx_query_pool_create(fdw_dx_context *context,
                                            uint32_t count) {
  if (context->timestampFrequency == 0) {
    fail("The queue writes no timestamps");
    return nullptr;
  }
  auto *pool = new fdw_dx_query_pool();
  pool->count = count;
  pool->resolved.assign(count, 0);
  D3D12_QUERY_HEAP_DESC desc{D3D12_QUERY_HEAP_TYPE_TIMESTAMP, count, 0};
  HRESULT result =
      context->device->CreateQueryHeap(&desc, IID_PPV_ARGS(&pool->heap));
  if (FAILED(result)) {
    delete pool;
    fail("CreateQueryHeap", result);
    return nullptr;
  }
  if (createBuffer(context, uint64_t(count) * 8, D3D12_HEAP_TYPE_READBACK,
                   D3D12_RESOURCE_STATE_COPY_DEST, &pool->readback) != 0) {
    delete pool;
    return nullptr;
  }
  // Mapped as long as the pool lives: read once the GPU wrote it.
  void *mapped = nullptr;
  result = pool->readback->Map(0, nullptr, &mapped);
  if (FAILED(result)) {
    delete pool;
    fail("Mapping the timestamps", result);
    return nullptr;
  }
  pool->ticks = static_cast<const uint64_t *>(mapped);
  pool->id = context->nextId++;
  context->queryPools[pool->id] = pool;
  return pool;
}

void fdw_dx_query_pool_destroy(fdw_dx_context *context,
                               fdw_dx_query_pool *pool) {
  if (!pool || !context->queryPools.erase(pool->id)) {
    return;
  }
  defer(context, [pool] { delete pool; });
}

uint32_t fdw_dx_query_pool_id(const fdw_dx_query_pool *pool) {
  return pool->id;
}

int fdw_dx_query_pool_read(fdw_dx_context *context, fdw_dx_query_pool *pool,
                           uint32_t first, uint32_t count,
                           double *nanoseconds) {
  if (first + count > pool->count) {
    return fail("Queries out of the pool");
  }
  const uint64_t done = completed(context);
  for (uint32_t i = first; i < first + count; i++) {
    if (pool->resolved[i] == 0 || pool->resolved[i] > done) {
      return 0;
    }
  }
  const double scale = 1e9 / static_cast<double>(context->timestampFrequency);
  for (uint32_t i = 0; i < count; i++) {
    nanoseconds[i] = static_cast<double>(pool->ticks[first + i]) * scale;
  }
  return 1;
}

} // extern "C"
