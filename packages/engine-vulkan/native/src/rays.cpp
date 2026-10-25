// Acceleration structures (VK_KHR_acceleration_structure), traced against
// by ray queries (VK_KHR_ray_query): a bottom level per mesh, built when it
// is created, and top levels of instances, built by a command of each
// frame.

#include "context.hpp"

#include <algorithm>
#include <cstring>

using namespace fdw;

namespace {

constexpr VkPipelineStageFlags2 BuildStage =
    VK_PIPELINE_STAGE_2_ACCELERATION_STRUCTURE_BUILD_BIT_KHR;

// A buffer of the GPU outside of the tracking: the memory of a structure,
// or the scratch memory of its builds.
int createDeviceBuffer(fdw_vk_context *context, uint64_t size,
                       VkBufferUsageFlags usage, VkBuffer *buffer,
                       VmaAllocation *allocation) {
  VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  info.size = std::max<uint64_t>(size, 4);
  info.usage = usage | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
  VmaAllocationCreateInfo create{};
  create.usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE;
  const VkResult result = vmaCreateBuffer(context->allocator, &info, &create,
                                          buffer, allocation, nullptr);
  return result == VK_SUCCESS ? 0 : fail("vmaCreateBuffer", result);
}

// The scratch memory of builds, aligned as the device asks.
int createScratch(fdw_vk_context *context, uint64_t size, VkBuffer *buffer,
                  VmaAllocation *allocation, VkDeviceAddress *address) {
  const uint64_t alignment = context->scratchAlignment;
  if (createDeviceBuffer(context, size + alignment,
                         VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, buffer,
                         allocation) != 0) {
    return -1;
  }
  const VkDeviceAddress base = bufferAddress(context, *buffer);
  *address = (base + alignment - 1) / alignment * alignment;
  return 0;
}

// A structure of `size` bytes, in a buffer of its own.
int createStructure(fdw_vk_context *context, VkAccelerationStructureTypeKHR type,
                    uint64_t size, VkBuffer *storage, VmaAllocation *allocation,
                    VkAccelerationStructureKHR *structure, const char *label) {
  if (createDeviceBuffer(context, size,
                         VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR,
                         storage, allocation) != 0) {
    return -1;
  }
  VkAccelerationStructureCreateInfoKHR info{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR};
  info.buffer = *storage;
  info.size = size;
  info.type = type;
  const VkResult result = vkCreateAccelerationStructureKHR(
      context->device, &info, nullptr, structure);
  if (result != VK_SUCCESS) {
    vmaDestroyBuffer(context->allocator, *storage, *allocation);
    return fail("vkCreateAccelerationStructureKHR", result);
  }
  setName(context, VK_OBJECT_TYPE_ACCELERATION_STRUCTURE_KHR,
          reinterpret_cast<uint64_t>(*structure), label);
  return 0;
}

VkDeviceAddress structureAddress(fdw_vk_context *context,
                                 VkAccelerationStructureKHR structure) {
  VkAccelerationStructureDeviceAddressInfoKHR info{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR};
  info.accelerationStructure = structure;
  return vkGetAccelerationStructureDeviceAddressKHR(context->device, &info);
}

// The geometry of a top level: its instances.
VkAccelerationStructureGeometryKHR instanceGeometry(VkDeviceAddress data) {
  VkAccelerationStructureGeometryKHR geometry{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR};
  geometry.geometryType = VK_GEOMETRY_TYPE_INSTANCES_KHR;
  geometry.geometry.instances = {
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_INSTANCES_DATA_KHR};
  geometry.geometry.instances.arrayOfPointers = VK_FALSE;
  geometry.geometry.instances.data.deviceAddress = data;
  return geometry;
}

// Frees the memory of a top level (once the GPU no longer uses it).
void releaseTopLevel(fdw_vk_context *context, fdw_vk_top_level *top) {
  VkDevice device = context->device;
  VmaAllocator allocator = context->allocator;
  const VkAccelerationStructureKHR structure = top->structure;
  const VkBuffer storage = top->storage;
  const VmaAllocation allocation = top->allocation;
  const VkBuffer scratch = top->scratch;
  const VmaAllocation scratchAllocation = top->scratchAllocation;
  defer(context, [=] {
    vkDestroyAccelerationStructureKHR(device, structure, nullptr);
    vmaDestroyBuffer(allocator, storage, allocation);
    vmaDestroyBuffer(allocator, scratch, scratchAllocation);
  });
  fdw_vk_buffer_destroy(context, top->instances);
  top->instances = nullptr;
}

// The memory of a top level of `capacity` instances.
int allocateTopLevel(fdw_vk_context *context, fdw_vk_top_level *top,
                     uint32_t capacity, const char *label) {
  top->instances = createBuffer(
      context, uint64_t(capacity) * sizeof(VkAccelerationStructureInstanceKHR),
      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
          VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
      label);
  if (!top->instances) {
    return -1;
  }
  const VkAccelerationStructureGeometryKHR geometry =
      instanceGeometry(bufferAddress(context, top->instances->buffer));
  VkAccelerationStructureBuildGeometryInfoKHR build{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR};
  build.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
  build.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
  build.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
  build.geometryCount = 1;
  build.pGeometries = &geometry;
  VkAccelerationStructureBuildSizesInfoKHR sizes{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR};
  vkGetAccelerationStructureBuildSizesKHR(
      context->device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR, &build,
      &capacity, &sizes);
  if (createStructure(context, VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR,
                      sizes.accelerationStructureSize, &top->storage,
                      &top->allocation, &top->structure, label) != 0) {
    fdw_vk_buffer_destroy(context, top->instances);
    top->instances = nullptr;
    return -1;
  }
  if (createScratch(context, sizes.buildScratchSize, &top->scratch,
                    &top->scratchAllocation, &top->scratchAddress) != 0) {
    vkDestroyAccelerationStructureKHR(context->device, top->structure,
                                      nullptr);
    vmaDestroyBuffer(context->allocator, top->storage, top->allocation);
    fdw_vk_buffer_destroy(context, top->instances);
    top->instances = nullptr;
    return -1;
  }
  top->capacity = capacity;
  // A new structure: nothing to wait for.
  top->last = {};
  return 0;
}

} // namespace

namespace fdw {

int buildTopLevel(fdw_vk_context *context, VkCommandBuffer commands,
                  fdw_vk_top_level *top) {
  // After the writes of its instances, and the last use of the structure
  // and of its scratch memory.
  Barriers barriers{commands};
  useBuffer(barriers, top->instances, BuildStage, VK_ACCESS_2_SHADER_READ_BIT);
  useTopLevel(barriers, top, BuildStage,
              VK_ACCESS_2_ACCELERATION_STRUCTURE_READ_BIT_KHR |
                  VK_ACCESS_2_ACCELERATION_STRUCTURE_WRITE_BIT_KHR);
  barriers.place();
  const VkAccelerationStructureGeometryKHR geometry =
      instanceGeometry(bufferAddress(context, top->instances->buffer));
  VkAccelerationStructureBuildGeometryInfoKHR build{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR};
  build.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
  build.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
  build.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
  build.dstAccelerationStructure = top->structure;
  build.geometryCount = 1;
  build.pGeometries = &geometry;
  build.scratchData.deviceAddress = top->scratchAddress;
  VkAccelerationStructureBuildRangeInfoKHR range{};
  range.primitiveCount = top->count;
  const VkAccelerationStructureBuildRangeInfoKHR *ranges = &range;
  vkCmdBuildAccelerationStructuresKHR(commands, 1, &build, &ranges);
  return 0;
}

void destroyAccelerationStructures(fdw_vk_context *context) {
  for (auto &[id, top] : context->topLevels) {
    vkDestroyAccelerationStructureKHR(context->device, top->structure, nullptr);
    vmaDestroyBuffer(context->allocator, top->storage, top->allocation);
    vmaDestroyBuffer(context->allocator, top->scratch, top->scratchAllocation);
    delete top;
  }
  context->topLevels.clear();
  for (auto &[id, bottom] : context->bottomLevels) {
    vkDestroyAccelerationStructureKHR(context->device, bottom->structure,
                                      nullptr);
    vmaDestroyBuffer(context->allocator, bottom->storage, bottom->allocation);
    delete bottom;
  }
  context->bottomLevels.clear();
}

} // namespace fdw

extern "C" {

int32_t fdw_vk_ray_query_supported(const fdw_vk_context *context) {
  return context->rayQuery ? 1 : 0;
}

fdw_vk_bottom_level *
fdw_vk_bottom_level_create(fdw_vk_context *context, const float *positions,
                           uint32_t vertex_count, const uint32_t *indices,
                           uint32_t index_count, const char *label) {
  if (!context->rayQuery) {
    fail("The device has no ray queries");
    return nullptr;
  }
  if (index_count < 3 || index_count % 3 != 0 || vertex_count == 0) {
    fail("A bottom level needs triangles: 3 indices each");
    return nullptr;
  }
  for (uint32_t i = 0; i < index_count; i++) {
    if (indices[i] >= vertex_count) {
      fail("The index " + std::to_string(indices[i]) + " is out of the " +
           std::to_string(vertex_count) + " vertices");
      return nullptr;
    }
  }
  // The triangles in buffers the build reads, written in the order of the
  // queue (staging copies of the transfers).
  constexpr VkBufferUsageFlags input =
      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
  const uint64_t vertexBytes = uint64_t(vertex_count) * 12;
  const uint64_t indexBytes = uint64_t(index_count) * 4;
  fdw_vk_buffer *vertices = createBuffer(context, vertexBytes, input, label);
  fdw_vk_buffer *indexBuffer = createBuffer(context, indexBytes, input, label);
  if (!vertices || !indexBuffer ||
      fdw_vk_buffer_write(context, vertices, 0, positions, vertexBytes) != 0 ||
      fdw_vk_buffer_write(context, indexBuffer, 0, indices, indexBytes) != 0) {
    fdw_vk_buffer_destroy(context, vertices);
    fdw_vk_buffer_destroy(context, indexBuffer);
    return nullptr;
  }

  VkAccelerationStructureGeometryKHR geometry{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR};
  geometry.geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR;
  geometry.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;
  auto &triangles = geometry.geometry.triangles;
  triangles = {
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR};
  triangles.vertexFormat = VK_FORMAT_R32G32B32_SFLOAT;
  triangles.vertexData.deviceAddress = bufferAddress(context, vertices->buffer);
  triangles.vertexStride = 12;
  triangles.maxVertex = vertex_count - 1;
  triangles.indexType = VK_INDEX_TYPE_UINT32;
  triangles.indexData.deviceAddress =
      bufferAddress(context, indexBuffer->buffer);
  VkAccelerationStructureBuildGeometryInfoKHR build{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR};
  build.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
  build.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
  build.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
  build.geometryCount = 1;
  build.pGeometries = &geometry;
  const uint32_t triangleCount = index_count / 3;
  VkAccelerationStructureBuildSizesInfoKHR sizes{
      VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR};
  vkGetAccelerationStructureBuildSizesKHR(
      context->device, VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR, &build,
      &triangleCount, &sizes);

  auto *bottom = new fdw_vk_bottom_level();
  bottom->triangleCount = triangleCount;
  VkBuffer scratch = VK_NULL_HANDLE;
  VmaAllocation scratchAllocation = nullptr;
  VkDeviceAddress scratchAddress = 0;
  if (createStructure(context, VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR,
                      sizes.accelerationStructureSize, &bottom->storage,
                      &bottom->allocation, &bottom->structure, label) != 0 ||
      createScratch(context, sizes.buildScratchSize, &scratch,
                    &scratchAllocation, &scratchAddress) != 0) {
    if (bottom->structure) {
      vkDestroyAccelerationStructureKHR(context->device, bottom->structure,
                                        nullptr);
      vmaDestroyBuffer(context->allocator, bottom->storage,
                       bottom->allocation);
    }
    delete bottom;
    fdw_vk_buffer_destroy(context, vertices);
    fdw_vk_buffer_destroy(context, indexBuffer);
    return nullptr;
  }
  bottom->address = structureAddress(context, bottom->structure);

  // Built with the transfers, after the copies of its triangles; the
  // builds of the top levels and the ray queries after it wait for it.
  VkCommandBuffer commands = transfers(context);
  {
    Barriers barriers{commands};
    useBuffer(barriers, vertices, BuildStage, VK_ACCESS_2_SHADER_READ_BIT);
    useBuffer(barriers, indexBuffer, BuildStage, VK_ACCESS_2_SHADER_READ_BIT);
  }
  build.dstAccelerationStructure = bottom->structure;
  build.scratchData.deviceAddress = scratchAddress;
  VkAccelerationStructureBuildRangeInfoKHR range{};
  range.primitiveCount = triangleCount;
  const VkAccelerationStructureBuildRangeInfoKHR *ranges = &range;
  vkCmdBuildAccelerationStructuresKHR(commands, 1, &build, &ranges);
  memoryBarrier(commands, BuildStage,
                VK_ACCESS_2_ACCELERATION_STRUCTURE_WRITE_BIT_KHR,
                VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT,
                VK_ACCESS_2_ACCELERATION_STRUCTURE_READ_BIT_KHR);

  // The inputs and the scratch memory are freed after the build.
  fdw_vk_buffer_destroy(context, vertices);
  fdw_vk_buffer_destroy(context, indexBuffer);
  VmaAllocator allocator = context->allocator;
  defer(context, [allocator, scratch, scratchAllocation] {
    vmaDestroyBuffer(allocator, scratch, scratchAllocation);
  });
  bottom->id = context->nextId++;
  context->bottomLevels[bottom->id] = bottom;
  return bottom;
}

void fdw_vk_bottom_level_destroy(fdw_vk_context *context,
                                 fdw_vk_bottom_level *bottom) {
  if (!bottom || !context->bottomLevels.erase(bottom->id)) {
    return;
  }
  VkDevice device = context->device;
  VmaAllocator allocator = context->allocator;
  defer(context, [device, allocator, bottom] {
    vkDestroyAccelerationStructureKHR(device, bottom->structure, nullptr);
    vmaDestroyBuffer(allocator, bottom->storage, bottom->allocation);
    delete bottom;
  });
}

uint32_t fdw_vk_bottom_level_id(const fdw_vk_bottom_level *bottom) {
  return bottom->id;
}

fdw_vk_top_level *fdw_vk_top_level_create(fdw_vk_context *context,
                                          uint32_t capacity,
                                          const char *label) {
  if (!context->rayQuery) {
    fail("The device has no ray queries");
    return nullptr;
  }
  auto *top = new fdw_vk_top_level();
  if (allocateTopLevel(context, top, std::max(capacity, 1u), label) != 0) {
    delete top;
    return nullptr;
  }
  top->id = context->nextId++;
  context->topLevels[top->id] = top;
  return top;
}

int fdw_vk_top_level_update(fdw_vk_context *context, fdw_vk_top_level *top,
                            const fdw_vk_instance *instances, uint32_t count) {
  std::vector<VkAccelerationStructureInstanceKHR> data(count);
  for (uint32_t i = 0; i < count; i++) {
    const fdw_vk_instance &instance = instances[i];
    const auto bottom = context->bottomLevels.find(instance.bottom_level);
    if (bottom == context->bottomLevels.end()) {
      return fail("Unknown bottom level " +
                  std::to_string(instance.bottom_level));
    }
    VkAccelerationStructureInstanceKHR &target = data[i];
    std::memcpy(target.transform.matrix, instance.transform,
                sizeof(target.transform.matrix));
    target.instanceCustomIndex = 0;
    target.mask = instance.mask & 0xff;
    target.instanceShaderBindingTableRecordOffset = 0;
    // Both faces, opaque: the hits report the face they saw. The triangles
    // of the engine are counterclockwise from their front, as in the
    // rasterization, the opposite of the default of the ray tracing.
    target.flags = VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR |
                   VK_GEOMETRY_INSTANCE_TRIANGLE_FLIP_FACING_BIT_KHR;
    target.accelerationStructureReference = bottom->second->address;
  }
  int replaced = 0;
  if (count > top->capacity) {
    const uint32_t capacity = std::max(count, top->capacity * 2);
    releaseTopLevel(context, top);
    if (allocateTopLevel(context, top, capacity, nullptr) != 0) {
      return -1;
    }
    replaced = 1;
  }
  if (count > 0 &&
      fdw_vk_buffer_write(context, top->instances, 0, data.data(),
                          uint64_t(count) * sizeof(data[0])) != 0) {
    return -1;
  }
  top->count = count;
  return replaced;
}

void fdw_vk_top_level_destroy(fdw_vk_context *context, fdw_vk_top_level *top) {
  if (!top || !context->topLevels.erase(top->id)) {
    return;
  }
  releaseTopLevel(context, top);
  defer(context, [top] { delete top; });
}

uint32_t fdw_vk_top_level_id(const fdw_vk_top_level *top) { return top->id; }

} // extern "C"
