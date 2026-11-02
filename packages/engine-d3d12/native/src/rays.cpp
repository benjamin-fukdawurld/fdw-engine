// Acceleration structures (DXR 1.1), traced against by ray queries and the
// ray tracing pipelines: a bottom level per mesh, built when it is created,
// and top levels of instances, built by a command of each frame. The
// structures stay in the acceleration structure state: UAV barriers order
// their builds and the rays.

#include "context.hpp"

#include <algorithm>
#include <cstring>

using namespace fdw;

namespace {

// The memory of a structure, or the scratch memory of its builds: a buffer
// of unordered access, outside of the tracking.
int createRayBuffer(fdw_dx_context *context, uint64_t size,
                    D3D12_RESOURCE_STATES state, const char *label,
                    ComPtr<ID3D12Resource> *result) {
  D3D12_HEAP_PROPERTIES properties{D3D12_HEAP_TYPE_DEFAULT};
  D3D12_RESOURCE_DESC desc{};
  desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  // The structures and the scratch memory are aligned to 256 bytes.
  desc.Width = std::max<uint64_t>(
      (size + D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BYTE_ALIGNMENT - 1) &
          ~uint64_t(D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BYTE_ALIGNMENT - 1),
      D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BYTE_ALIGNMENT);
  desc.Height = 1;
  desc.DepthOrArraySize = 1;
  desc.MipLevels = 1;
  desc.SampleDesc.Count = 1;
  desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
  const HRESULT status = context->device->CreateCommittedResource(
      &properties, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr,
      IID_PPV_ARGS(result->ReleaseAndGetAddressOf()));
  if (FAILED(status)) {
    return fail("CreateCommittedResource (acceleration structure)", status);
  }
  setName(result->Get(), label);
  return 0;
}

// A structure: its storage in the acceleration structure state.
int createStructure(fdw_dx_context *context, uint64_t size, const char *label,
                    ComPtr<ID3D12Resource> *result) {
  return createRayBuffer(context, size,
                         D3D12_RESOURCE_STATE_RAYTRACING_ACCELERATION_STRUCTURE,
                         label, result);
}

// Scratch memory: buffers are created in the common state, promoted to
// unordered access by the builds.
int createScratch(fdw_dx_context *context, uint64_t size,
                  ComPtr<ID3D12Resource> *result) {
  return createRayBuffer(context, size, D3D12_RESOURCE_STATE_COMMON, nullptr,
                         result);
}

// The accesses to a structure before are complete before the next ones.
void structureBarrier(ID3D12GraphicsCommandList *list,
                      ID3D12Resource *structure) {
  D3D12_RESOURCE_BARRIER barrier{};
  barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
  barrier.UAV.pResource = structure;
  list->ResourceBarrier(1, &barrier);
}

// The flags of the builds of a bottom level: updatable when dynamic.
D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAGS bottomFlags(bool dynamic) {
  return D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE |
         (dynamic
              ? D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_ALLOW_UPDATE
              : D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_NONE);
}

// The triangles of a bottom level: the vertices at an address, its indices.
D3D12_RAYTRACING_GEOMETRY_DESC
triangleGeometry(D3D12_GPU_VIRTUAL_ADDRESS vertices, uint64_t stride,
                 uint32_t vertexCount, D3D12_GPU_VIRTUAL_ADDRESS indices,
                 uint32_t indexCount) {
  D3D12_RAYTRACING_GEOMETRY_DESC geometry{};
  geometry.Type = D3D12_RAYTRACING_GEOMETRY_TYPE_TRIANGLES;
  geometry.Flags = D3D12_RAYTRACING_GEOMETRY_FLAG_OPAQUE;
  auto &triangles = geometry.Triangles;
  triangles.IndexFormat = DXGI_FORMAT_R32_UINT;
  triangles.VertexFormat = DXGI_FORMAT_R32G32B32_FLOAT;
  triangles.IndexCount = indexCount;
  triangles.VertexCount = vertexCount;
  triangles.IndexBuffer = indices;
  triangles.VertexBuffer = {vertices, stride};
  return geometry;
}

D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS
topInputs(D3D12_GPU_VIRTUAL_ADDRESS instances, uint32_t count) {
  D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_INPUTS inputs{};
  inputs.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL;
  inputs.Flags =
      D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PREFER_FAST_TRACE;
  inputs.NumDescs = count;
  inputs.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
  inputs.InstanceDescs = instances;
  return inputs;
}

// The instance in place of none: WARP (10.0.26100, the CI runners) divides
// by the count of the instances of a build, and reads the bottom level of
// the instances without one. A triangle in a bottom level of its own, that
// no ray sees (mask 0).
int inactiveInstance(fdw_dx_context *context,
                     D3D12_RAYTRACING_INSTANCE_DESC *instance) {
  if (!context->inactiveBottomLevel) {
    const float positions[] = {0, 0, 0, 1, 0, 0, 0, 1, 0};
    const uint32_t indices[] = {0, 1, 2};
    context->inactiveBottomLevel = fdw_dx_bottom_level_create(
        context, positions, 3, indices, 3, 0, "inactive instance");
    if (!context->inactiveBottomLevel) {
      return -1;
    }
  }
  *instance = {};
  instance->Transform[0][0] = 1;
  instance->Transform[1][1] = 1;
  instance->Transform[2][2] = 1;
  instance->AccelerationStructure =
      context->inactiveBottomLevel->storage->GetGPUVirtualAddress();
  return 0;
}

// Frees the memory of a top level (once the GPU no longer uses it).
void releaseTopLevel(fdw_dx_context *context, fdw_dx_top_level *top) {
  ComPtr<ID3D12Resource> storage = std::move(top->storage);
  ComPtr<ID3D12Resource> scratch = std::move(top->scratch);
  std::vector<ComPtr<ID3D12Resource>> bottomLevels =
      std::move(top->bottomLevels);
  top->bottomLevels.clear();
  defer(context, [storage, scratch, bottomLevels] {});
  fdw_dx_buffer_destroy(context, top->instances);
  top->instances = nullptr;
}

// The memory of a top level of `capacity` instances.
int allocateTopLevel(fdw_dx_context *context, fdw_dx_top_level *top,
                     uint32_t capacity, const char *label) {
  top->instances = fdw_dx_buffer_create(
      context,
      uint64_t(capacity) * sizeof(D3D12_RAYTRACING_INSTANCE_DESC), 0, label);
  if (!top->instances) {
    return -1;
  }
  const auto inputs = topInputs(
      top->instances->resource->GetGPUVirtualAddress(), capacity);
  D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO sizes{};
  context->rayDevice->GetRaytracingAccelerationStructurePrebuildInfo(&inputs,
                                                                    &sizes);
  if (createStructure(context, sizes.ResultDataMaxSizeInBytes, label,
                      &top->storage) != 0 ||
      createScratch(context, sizes.ScratchDataSizeInBytes, &top->scratch) !=
          0) {
    top->storage.Reset();
    fdw_dx_buffer_destroy(context, top->instances);
    top->instances = nullptr;
    return -1;
  }
  top->capacity = capacity;
  return 0;
}

} // namespace

namespace fdw {

int refitBottomLevel(fdw_dx_context *context, ID3D12GraphicsCommandList4 *list,
                     fdw_dx_bottom_level *bottom, fdw_dx_buffer *source,
                     uint64_t offset, uint32_t stride) {
  if (!bottom->dynamic) {
    return fail("Only the dynamic bottom levels are refit");
  }
  if (stride < 12 || stride % 4 != 0 || offset % 4 != 0 ||
      offset + uint64_t(bottom->vertexCount - 1) * stride + 12 >
          source->size) {
    return fail("The vertices of the refit are outside of the buffer");
  }
  // After the writes of the vertices, and the last uses of the structure
  // (the rays and builds of the commands before).
  {
    Barriers barriers{context, list};
    barriers.buffer(source, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    barriers.buffer(bottom->indices,
                    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
  }
  structureBarrier(list, bottom->storage.Get());
  const D3D12_RAYTRACING_GEOMETRY_DESC geometry = triangleGeometry(
      source->resource->GetGPUVirtualAddress() + offset, stride,
      bottom->vertexCount,
      bottom->indices->resource->GetGPUVirtualAddress(),
      bottom->triangleCount * 3);
  D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};
  build.Inputs.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL;
  build.Inputs.Flags =
      bottomFlags(true) |
      D3D12_RAYTRACING_ACCELERATION_STRUCTURE_BUILD_FLAG_PERFORM_UPDATE;
  build.Inputs.NumDescs = 1;
  build.Inputs.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
  build.Inputs.pGeometryDescs = &geometry;
  build.SourceAccelerationStructureData =
      bottom->storage->GetGPUVirtualAddress();
  build.DestAccelerationStructureData = bottom->storage->GetGPUVirtualAddress();
  build.ScratchAccelerationStructureData =
      bottom->updateScratch->GetGPUVirtualAddress();
  list->BuildRaytracingAccelerationStructure(&build, 0, nullptr);
  // The builds of the top levels and the rays after it wait for it.
  structureBarrier(list, bottom->storage.Get());
  return 0;
}

int buildTopLevel(fdw_dx_context *context, ID3D12GraphicsCommandList4 *list,
                  fdw_dx_top_level *top) {
  // After the writes of its instances, and the last use of the structure
  // and of its scratch memory.
  {
    Barriers barriers{context, list};
    barriers.buffer(top->instances,
                    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
  }
  structureBarrier(list, top->storage.Get());
  // Without instances, the inactive one written in their place.
  D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};
  build.Inputs = topInputs(top->instances->resource->GetGPUVirtualAddress(),
                           std::max(top->count, 1u));
  build.DestAccelerationStructureData = top->storage->GetGPUVirtualAddress();
  build.ScratchAccelerationStructureData =
      top->scratch->GetGPUVirtualAddress();
  list->BuildRaytracingAccelerationStructure(&build, 0, nullptr);
  // The passes after it trace against it.
  structureBarrier(list, top->storage.Get());
  return 0;
}

void destroyAccelerationStructures(fdw_dx_context *context) {
  // Their buffers (instances, indices) go with those of the context.
  for (auto &[id, top] : context->topLevels) {
    delete top;
  }
  context->topLevels.clear();
  for (auto &[id, bottom] : context->bottomLevels) {
    delete bottom;
  }
  context->bottomLevels.clear();
  context->inactiveBottomLevel = nullptr;
}

} // namespace fdw

extern "C" {

int32_t fdw_dx_ray_query_supported(const fdw_dx_context *context) {
  return context->rayQuery ? 1 : 0;
}

fdw_dx_bottom_level *
fdw_dx_bottom_level_create(fdw_dx_context *context, const float *positions,
                           uint32_t vertex_count, const uint32_t *indices,
                           uint32_t index_count, uint32_t flags,
                           const char *label) {
  const bool dynamic = (flags & FDW_DX_BOTTOM_LEVEL_DYNAMIC) != 0;
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
  // queue.
  const uint64_t vertexBytes = uint64_t(vertex_count) * 12;
  const uint64_t indexBytes = uint64_t(index_count) * 4;
  fdw_dx_buffer *vertices =
      fdw_dx_buffer_create(context, vertexBytes, 0, label);
  fdw_dx_buffer *indexBuffer =
      fdw_dx_buffer_create(context, indexBytes, 0, label);
  if (!vertices || !indexBuffer ||
      fdw_dx_buffer_write(context, vertices, 0, positions, vertexBytes) != 0 ||
      fdw_dx_buffer_write(context, indexBuffer, 0, indices, indexBytes) != 0) {
    fdw_dx_buffer_destroy(context, vertices);
    fdw_dx_buffer_destroy(context, indexBuffer);
    return nullptr;
  }

  const D3D12_RAYTRACING_GEOMETRY_DESC geometry = triangleGeometry(
      vertices->resource->GetGPUVirtualAddress(), 12, vertex_count,
      indexBuffer->resource->GetGPUVirtualAddress(), index_count);
  D3D12_BUILD_RAYTRACING_ACCELERATION_STRUCTURE_DESC build{};
  build.Inputs.Type = D3D12_RAYTRACING_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL;
  build.Inputs.Flags = bottomFlags(dynamic);
  build.Inputs.NumDescs = 1;
  build.Inputs.DescsLayout = D3D12_ELEMENTS_LAYOUT_ARRAY;
  build.Inputs.pGeometryDescs = &geometry;
  D3D12_RAYTRACING_ACCELERATION_STRUCTURE_PREBUILD_INFO sizes{};
  context->rayDevice->GetRaytracingAccelerationStructurePrebuildInfo(
      &build.Inputs, &sizes);

  auto *bottom = new fdw_dx_bottom_level();
  bottom->triangleCount = index_count / 3;
  bottom->vertexCount = vertex_count;
  bottom->dynamic = dynamic;
  ComPtr<ID3D12Resource> scratch;
  if (createStructure(context, sizes.ResultDataMaxSizeInBytes, label,
                      &bottom->storage) != 0 ||
      createScratch(context, sizes.ScratchDataSizeInBytes, &scratch) != 0 ||
      (dynamic && createScratch(context, sizes.UpdateScratchDataSizeInBytes,
                                &bottom->updateScratch) != 0)) {
    delete bottom;
    fdw_dx_buffer_destroy(context, vertices);
    fdw_dx_buffer_destroy(context, indexBuffer);
    return nullptr;
  }

  // Built with the transfers, after the copies of its triangles; the
  // builds of the top levels and the rays after it wait for it.
  ID3D12GraphicsCommandList *list = transfers(context);
  if (!list) {
    delete bottom;
    fdw_dx_buffer_destroy(context, vertices);
    fdw_dx_buffer_destroy(context, indexBuffer);
    return nullptr;
  }
  {
    Barriers barriers{context, list};
    barriers.buffer(vertices, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    barriers.buffer(indexBuffer,
                    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
  }
  build.DestAccelerationStructureData = bottom->storage->GetGPUVirtualAddress();
  build.ScratchAccelerationStructureData = scratch->GetGPUVirtualAddress();
  context->transfers->rays->BuildRaytracingAccelerationStructure(&build, 0,
                                                                 nullptr);
  structureBarrier(list, bottom->storage.Get());

  // The inputs and the scratch memory are freed after the build; the
  // indices of a dynamic one are kept for its refits.
  fdw_dx_buffer_destroy(context, vertices);
  if (dynamic) {
    bottom->indices = indexBuffer;
  } else {
    fdw_dx_buffer_destroy(context, indexBuffer);
  }
  defer(context, [scratch] {});
  bottom->id = context->nextId++;
  context->bottomLevels[bottom->id] = bottom;
  return bottom;
}

void fdw_dx_bottom_level_destroy(fdw_dx_context *context,
                                 fdw_dx_bottom_level *bottom) {
  if (!bottom || !context->bottomLevels.erase(bottom->id)) {
    return;
  }
  fdw_dx_buffer_destroy(context, bottom->indices);
  defer(context, [bottom] { delete bottom; });
}

uint32_t fdw_dx_bottom_level_id(const fdw_dx_bottom_level *bottom) {
  return bottom->id;
}

fdw_dx_top_level *fdw_dx_top_level_create(fdw_dx_context *context,
                                          uint32_t capacity,
                                          const char *label) {
  if (!context->rayQuery) {
    fail("The device has no ray queries");
    return nullptr;
  }
  auto *top = new fdw_dx_top_level();
  // The inactive instance until the first update: the builds have one.
  D3D12_RAYTRACING_INSTANCE_DESC inactive;
  if (allocateTopLevel(context, top, std::max(capacity, 1u), label) != 0) {
    delete top;
    return nullptr;
  }
  if (inactiveInstance(context, &inactive) != 0 ||
      fdw_dx_buffer_write(context, top->instances, 0, &inactive,
                          sizeof(inactive)) != 0) {
    releaseTopLevel(context, top);
    delete top;
    return nullptr;
  }
  top->id = context->nextId++;
  context->topLevels[top->id] = top;
  return top;
}

// Whether an object to world matrix (3 rows of 4) mirrors: its 3 x 3 part
// has a negative determinant. The winding of its triangles is then turned
// over in the world, where the hits report their face (as the CPU and the
// WebGPU traversals).
static bool mirrors(const float *m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) -
             m[1] * (m[4] * m[10] - m[6] * m[8]) +
             m[2] * (m[4] * m[9] - m[5] * m[8]) <
         0;
}

int fdw_dx_top_level_update(fdw_dx_context *context, fdw_dx_top_level *top,
                            const fdw_dx_instance *instances, uint32_t count) {
  std::vector<D3D12_RAYTRACING_INSTANCE_DESC> data(count);
  // The bottom levels of the instances, kept alive by the structure.
  std::vector<ComPtr<ID3D12Resource>> bottomLevels;
  bottomLevels.reserve(count);
  for (uint32_t i = 0; i < count; i++) {
    const fdw_dx_instance &instance = instances[i];
    const auto bottom = context->bottomLevels.find(instance.bottom_level);
    if (bottom == context->bottomLevels.end()) {
      return fail("Unknown bottom level " +
                  std::to_string(instance.bottom_level));
    }
    D3D12_RAYTRACING_INSTANCE_DESC &target = data[i];
    std::memcpy(target.Transform, instance.transform,
                sizeof(target.Transform));
    target.InstanceID = 0;
    target.InstanceMask = instance.mask & 0xff;
    target.InstanceContributionToHitGroupIndex = 0;
    // Both faces: the hits report the face they saw (counterclockwise from
    // the front, as in the rasterization, without
    // TRIANGLE_FRONT_COUNTERCLOCKWISE: the convention of Vulkan without
    // TRIANGLE_FLIP_FACING), set for a mirror: the front face is the one
    // seen counterclockwise in the world. Opaque unless bit 8 of the mask.
    target.Flags = D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_CULL_DISABLE |
                   (mirrors(instance.transform)
                        ? D3D12_RAYTRACING_INSTANCE_FLAG_TRIANGLE_FRONT_COUNTERCLOCKWISE
                        : 0) |
                   ((instance.mask & 0x100) != 0
                        ? D3D12_RAYTRACING_INSTANCE_FLAG_FORCE_NON_OPAQUE
                        : D3D12_RAYTRACING_INSTANCE_FLAG_FORCE_OPAQUE);
    target.AccelerationStructure =
        bottom->second->storage->GetGPUVirtualAddress();
    bottomLevels.push_back(bottom->second->storage);
  }
  int replaced = 0;
  if (count > top->capacity) {
    // The larger memory allocated before the current one is freed: on
    // failure, the top level stays as it was.
    fdw_dx_top_level larger;
    if (allocateTopLevel(context, &larger,
                         std::max(count, top->capacity * 2), nullptr) != 0) {
      return -1;
    }
    releaseTopLevel(context, top);
    top->storage = std::move(larger.storage);
    top->scratch = std::move(larger.scratch);
    top->instances = larger.instances;
    top->capacity = larger.capacity;
    replaced = 1;
  }
  if (count == 0) {
    data.resize(1);
    if (inactiveInstance(context, &data[0]) != 0) {
      return -1;
    }
  }
  if (fdw_dx_buffer_write(context, top->instances, 0, data.data(),
                          uint64_t(data.size()) * sizeof(data[0])) != 0) {
    return -1;
  }
  top->count = count;
  // Those of the update before, while the builds and rays recorded may
  // still use them.
  std::vector<ComPtr<ID3D12Resource>> previous = std::move(top->bottomLevels);
  defer(context, [previous] {});
  top->bottomLevels = std::move(bottomLevels);
  return replaced;
}

void fdw_dx_top_level_destroy(fdw_dx_context *context, fdw_dx_top_level *top) {
  if (!top || !context->topLevels.erase(top->id)) {
    return;
  }
  releaseTopLevel(context, top);
  defer(context, [top] { delete top; });
}

uint32_t fdw_dx_top_level_id(const fdw_dx_top_level *top) { return top->id; }

} // extern "C"
