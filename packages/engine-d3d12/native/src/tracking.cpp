// The tracking of the resources (option A of design/native-backends.md,
// §8.1): each texture keeps its state, each buffer its state in the command
// list being recorded (buffers decay to the common state between
// executions). A use in another state needs a transition barrier; two uses
// as unordered access views, a UAV barrier.

#include "context.hpp"

using namespace fdw;

namespace {

// The state of the uses of a pass: read states combined, a write wins.
D3D12_RESOURCE_STATES combine(D3D12_RESOURCE_STATES first,
                              D3D12_RESOURCE_STATES second) {
  if (readOnly(first) && readOnly(second)) {
    return first | second;
  }
  return readOnly(second) ? first : second;
}

// A barrier, when one is needed, from `current` to `next`.
bool barrier(ID3D12Resource *resource, D3D12_RESOURCE_STATES current,
             D3D12_RESOURCE_STATES next, bool unorderedWrite,
             std::vector<D3D12_RESOURCE_BARRIER> &barriers) {
  D3D12_RESOURCE_BARRIER entry{};
  if (current == next) {
    if (next != D3D12_RESOURCE_STATE_UNORDERED_ACCESS || !unorderedWrite) {
      return false;
    }
    // The writes before are complete before the next accesses.
    entry.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    entry.UAV.pResource = resource;
    barriers.push_back(entry);
    return true;
  }
  // Already readable in every way the next use reads.
  if (readOnly(current) && readOnly(next) && (current & next) == next) {
    return false;
  }
  entry.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
  entry.Transition.pResource = resource;
  entry.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
  entry.Transition.StateBefore = current;
  entry.Transition.StateAfter = next;
  barriers.push_back(entry);
  return true;
}

} // namespace

namespace fdw {

D3D12_RESOURCE_STATES bufferState(const fdw_dx_context *context,
                                  const fdw_dx_buffer *buffer) {
  return buffer->epoch == context->epoch ? buffer->state
                                         : D3D12_RESOURCE_STATE_COMMON;
}

void Barriers::texture(fdw_dx_texture *texture, D3D12_RESOURCE_STATES state) {
  for (auto &[candidate, wanted] : textures) {
    if (candidate == texture) {
      wanted = combine(wanted, state);
      return;
    }
  }
  textures.emplace_back(texture, state);
}

void Barriers::buffer(fdw_dx_buffer *buffer, D3D12_RESOURCE_STATES state) {
  for (auto &[candidate, wanted] : buffers) {
    if (candidate == buffer) {
      wanted = combine(wanted, state);
      return;
    }
  }
  buffers.emplace_back(buffer, state);
}

void Barriers::place() {
  std::vector<D3D12_RESOURCE_BARRIER> barriers;
  for (auto &[texture, state] : textures) {
    if (barrier(texture->resource.Get(), texture->state, state, false,
                barriers) &&
        barriers.back().Type == D3D12_RESOURCE_BARRIER_TYPE_TRANSITION) {
      texture->state = state;
    }
  }
  for (auto &[buffer, state] : buffers) {
    const D3D12_RESOURCE_STATES current = bufferState(context, buffer);
    if (barrier(buffer->resource.Get(), current, state, buffer->unorderedWrite,
                barriers) &&
        barriers.back().Type == D3D12_RESOURCE_BARRIER_TYPE_TRANSITION) {
      buffer->state = state;
    } else {
      buffer->state = current;
    }
    buffer->epoch = context->epoch;
    buffer->unorderedWrite = state == D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
  }
  textures.clear();
  buffers.clear();
  if (!barriers.empty()) {
    list->ResourceBarrier(static_cast<UINT>(barriers.size()), barriers.data());
  }
}

void useTexture(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
                fdw_dx_texture *texture, D3D12_RESOURCE_STATES state) {
  Barriers barriers{context, list};
  barriers.texture(texture, state);
}

void useBuffer(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
               fdw_dx_buffer *buffer, D3D12_RESOURCE_STATES state) {
  Barriers barriers{context, list};
  barriers.buffer(buffer, state);
}

} // namespace fdw
