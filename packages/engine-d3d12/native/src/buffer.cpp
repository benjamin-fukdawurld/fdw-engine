// Buffers: creation, writes through the upload memory, reads back.

#include "context.hpp"

#include <cstring>

using namespace fdw;

namespace {

int checkRange(const fdw_dx_buffer *buffer, uint64_t offset, uint64_t size) {
  if (offset + size > buffer->size || offset + size < offset) {
    return fail("The range " + std::to_string(offset) + " + " +
                std::to_string(size) + " is outside of the buffer (" +
                std::to_string(buffer->size) + " bytes)");
  }
  return 0;
}

} // namespace

extern "C" {

uint32_t fdw_dx_buffer_id(const fdw_dx_buffer *buffer) { return buffer->id; }

fdw_dx_buffer *fdw_dx_buffer_create(fdw_dx_context *context, uint64_t size,
                                    uint32_t usage, const char *label) {
  auto *buffer = new fdw_dx_buffer();
  buffer->size = size;
  // Constant buffer views take multiples of 256 bytes.
  buffer->allocated = std::max<uint64_t>((size + 255) & ~255ull, 256);
  D3D12_HEAP_PROPERTIES properties{D3D12_HEAP_TYPE_DEFAULT};
  D3D12_RESOURCE_DESC desc{};
  desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  desc.Width = buffer->allocated;
  desc.Height = 1;
  desc.DepthOrArraySize = 1;
  desc.MipLevels = 1;
  desc.SampleDesc.Count = 1;
  desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  if (usage & FDW_DX_BUFFER_STORAGE) {
    desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;
  }
  // Committed resources are filled with zeros, as WebGPU wants.
  const HRESULT result = context->device->CreateCommittedResource(
      &properties, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_COMMON,
      nullptr, IID_PPV_ARGS(&buffer->resource));
  if (FAILED(result)) {
    delete buffer;
    fail("CreateCommittedResource (buffer)", result);
    return nullptr;
  }
  setName(buffer->resource.Get(), label);
  buffer->id = context->nextId++;
  context->buffers[buffer->id] = buffer;
  return buffer;
}

void fdw_dx_buffer_destroy(fdw_dx_context *context, fdw_dx_buffer *buffer) {
  if (!buffer || !context->buffers.erase(buffer->id)) {
    return;
  }
  defer(context, [buffer] { delete buffer; });
}

int fdw_dx_buffer_write(fdw_dx_context *context, fdw_dx_buffer *buffer,
                        uint64_t offset, const void *data, uint64_t size) {
  if (size == 0) {
    return 0;
  }
  if (checkRange(buffer, offset, size) != 0) {
    return -1;
  }
  ID3D12GraphicsCommandList *list = transfers(context);
  Upload staging;
  if (!list || upload(context, size, 16, &staging) != 0) {
    return -1;
  }
  std::memcpy(staging.data, data, size);
  useBuffer(context, list, buffer, D3D12_RESOURCE_STATE_COPY_DEST);
  list->CopyBufferRegion(buffer->resource.Get(), offset, staging.resource,
                         staging.offset, size);
  return 0;
}

int fdw_dx_buffer_read(fdw_dx_context *context, fdw_dx_buffer *buffer,
                       uint64_t offset, uint64_t size, uint64_t *ticket) {
  if (checkRange(buffer, offset, size) != 0) {
    return -1;
  }
  PendingRead read;
  if (createBuffer(context, size, D3D12_HEAP_TYPE_READBACK,
                   D3D12_RESOURCE_STATE_COPY_DEST, &read.readback) != 0) {
    return -1;
  }
  ID3D12GraphicsCommandList *list = transfers(context);
  if (!list) {
    return -1;
  }
  useBuffer(context, list, buffer, D3D12_RESOURCE_STATE_COPY_SOURCE);
  if (size > 0) {
    list->CopyBufferRegion(read.readback.Get(), 0, buffer->resource.Get(),
                           offset, size);
  }
  read.submission = submit(context);
  if (read.submission == 0) {
    return -1;
  }
  read.pitch = read.rowSize = size;
  *ticket = addRead(context, std::move(read));
  return 0;
}

} // extern "C"
