// The replay of the commands of a submission (FDW_DX_CMD_*), with the
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

// The arguments of the indirect dispatches: the workgroups twice, as root
// constants (the number of workgroups the shaders read) then as the
// dispatch, copied from the indirect buffer.
constexpr uint64_t ScratchSize = 64 * 1024;
constexpr uint64_t ScratchSlot = 32;

// The state of the replay of a submission.
struct Replay {
  fdw_dx_context *context;
  ID3D12GraphicsCommandList *list;
  Reader reader;
  bool inRenderPass = false;
  bool inComputePass = false;
  // The pipeline, its root signature as set, and the groups, bound at the
  // next draw or dispatch.
  fdw_dx_pipeline *pipeline = nullptr;
  RootSignature *root = nullptr;
  std::array<fdw_dx_group *, 8> groups{};
  std::array<bool, 8> dirty{};
  std::array<fdw_dx_buffer *, 16> vertexBuffers{};
  bool vertexDirty = false;
  // The first instance set as a root constant (none: ~0).
  uint32_t firstInstance = ~0u;
  // The resolves at the end of the render pass: target, resolve target.
  std::vector<std::pair<fdw_dx_texture *, fdw_dx_texture *>> resolves;
  // The buffer of the arguments of the indirect dispatches.
  ComPtr<ID3D12Resource> scratch;
  uint64_t scratchUsed = 0;
  D3D12_RESOURCE_STATES scratchState = D3D12_RESOURCE_STATE_COMMON;
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

// The viewport and scissor of a region, in pixels from the top left corner:
// Direct3D has y up in clip space and down in the viewport, as WebGPU.
void setViewport(ID3D12GraphicsCommandList *list, float x, float y,
                 float width, float height) {
  const D3D12_VIEWPORT viewport{x, y, width, height, 0, 1};
  list->RSSetViewports(1, &viewport);
  const D3D12_RECT scissor{static_cast<LONG>(x), static_cast<LONG>(y),
                           static_cast<LONG>(x + width),
                           static_cast<LONG>(y + height)};
  list->RSSetScissorRects(1, &scissor);
}

bool isIntegerFormat(DXGI_FORMAT format) {
  switch (format) {
  case DXGI_FORMAT_R8_UINT:
  case DXGI_FORMAT_R8G8_UINT:
  case DXGI_FORMAT_R8G8B8A8_UINT:
  case DXGI_FORMAT_R16_UINT:
  case DXGI_FORMAT_R16G16_UINT:
  case DXGI_FORMAT_R16G16B16A16_UINT:
  case DXGI_FORMAT_R32_UINT:
  case DXGI_FORMAT_R32G32_UINT:
  case DXGI_FORMAT_R32G32B32A32_UINT:
  case DXGI_FORMAT_R8_SINT:
  case DXGI_FORMAT_R8G8_SINT:
  case DXGI_FORMAT_R8G8B8A8_SINT:
  case DXGI_FORMAT_R16_SINT:
  case DXGI_FORMAT_R16G16_SINT:
  case DXGI_FORMAT_R16G16B16A16_SINT:
  case DXGI_FORMAT_R32_SINT:
  case DXGI_FORMAT_R32G32_SINT:
  case DXGI_FORMAT_R32G32B32A32_SINT:
    return true;
  default:
    return false;
  }
}

// The operands of each command, to walk the commands of a pass ahead.
uint32_t operandCount(uint32_t opcode) {
  switch (opcode) {
  case FDW_DX_CMD_SET_PIPELINE:
    return 1;
  case FDW_DX_CMD_SET_GROUP:
  case FDW_DX_CMD_SET_VERTEX_BUFFER:
  case FDW_DX_CMD_SET_INDEX_BUFFER:
    return 2;
  case FDW_DX_CMD_DRAW:
  case FDW_DX_CMD_DRAW_INDEXED:
    return 3;
  case FDW_DX_CMD_SET_VIEWPORT:
    return 4;
  case FDW_DX_CMD_DISPATCH:
    return 3;
  case FDW_DX_CMD_DISPATCH_INDIRECT:
    return 3;
  default:
    return 0;
  }
}

// The states of the resources of a group, gathered into the barriers of
// the pass.
int useGroup(Replay &replay, Barriers &barriers, const fdw_dx_group *group) {
  fdw_dx_context *context = replay.context;
  for (const auto &[kind, id] : group->used) {
    if (kind == FDW_DX_BINDING_TEXTURE) {
      const auto texture = context->textures.find(id);
      if (texture == context->textures.end()) {
        return fail("A group uses the destroyed texture " + std::to_string(id));
      }
      barriers.texture(texture->second, ShaderRead);
      continue;
    }
    const auto buffer = context->buffers.find(id);
    if (buffer == context->buffers.end()) {
      return fail("A group uses the destroyed buffer " + std::to_string(id));
    }
    barriers.buffer(buffer->second,
                    kind == FDW_DX_BINDING_UNIFORM
                        ? D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER
                    : kind == FDW_DX_BINDING_STORAGE_READ
                        ? ShaderRead
                        : D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
  }
  return 0;
}

// Before a render pass: the barriers of the resources its commands use,
// which cannot be placed inside it, gathered with those of its attachments.
// The commands are walked ahead, up to the end of the pass.
int prepareRenderPass(Replay &replay, Barriers &barriers) {
  Reader ahead = replay.reader;
  int status = 0;
  while (!ahead.done()) {
    const uint32_t opcode = ahead.word();
    if (opcode == FDW_DX_CMD_END_RENDER_PASS) {
      return 0;
    }
    if (opcode == FDW_DX_CMD_SET_GROUP) {
      ahead.word();
      const fdw_dx_group *group =
          find(replay.context->groups, ahead.word(), "group", &status);
      if (!group || useGroup(replay, barriers, group) != 0) {
        return -1;
      }
    } else if (opcode == FDW_DX_CMD_SET_VERTEX_BUFFER ||
               opcode == FDW_DX_CMD_SET_INDEX_BUFFER) {
      const uint32_t first = ahead.word();
      const uint32_t second = ahead.word();
      const bool vertex = opcode == FDW_DX_CMD_SET_VERTEX_BUFFER;
      fdw_dx_buffer *buffer = find(replay.context->buffers,
                                   vertex ? second : first, "buffer", &status);
      if (!buffer) {
        return status;
      }
      barriers.buffer(buffer,
                      vertex ? D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER
                             : D3D12_RESOURCE_STATE_INDEX_BUFFER);
    } else {
      for (uint32_t i = operandCount(opcode); i > 0; i--) {
        ahead.word();
      }
    }
  }
  return 0;
}

// Binds the groups set since the last draw or dispatch, in the tables of
// the root signature of the pipeline.
int flushGroups(Replay &replay) {
  if (!replay.pipeline) {
    return fail("No pipeline set before drawing");
  }
  const RootSignature *root = replay.pipeline->root;
  const bool compute = replay.pipeline->compute;
  fdw_dx_context *context = replay.context;
  for (uint32_t index = 0; index < replay.groups.size(); index++) {
    const fdw_dx_group *group = replay.groups[index];
    // A group without tables in this pipeline: what is bound there stays
    // for the next.
    if (!replay.dirty[index] || !group ||
        index >= root->resourceTables.size()) {
      continue;
    }
    const int32_t resources = root->resourceTables[index];
    const int32_t samplers = root->samplerTables[index];
    if (resources >= 0 && group->resources >= 0) {
      const auto handle =
          context->views.gpu(static_cast<uint32_t>(group->resources));
      compute ? replay.list->SetComputeRootDescriptorTable(resources, handle)
              : replay.list->SetGraphicsRootDescriptorTable(resources, handle);
    }
    if (samplers >= 0 && group->samplers >= 0) {
      const auto handle =
          context->samplerHeap.gpu(static_cast<uint32_t>(group->samplers));
      compute ? replay.list->SetComputeRootDescriptorTable(samplers, handle)
              : replay.list->SetGraphicsRootDescriptorTable(samplers, handle);
    }
    replay.dirty[index] = false;
  }
  return 0;
}

// The arguments of an indirect dispatch, copied twice into the scratch
// buffer: its offset there.
int indirectArguments(Replay &replay, fdw_dx_buffer *buffer, uint64_t offset,
                      uint64_t *slot) {
  fdw_dx_context *context = replay.context;
  if (!replay.scratch || replay.scratchUsed + ScratchSlot > ScratchSize) {
    if (replay.scratch) {
      ComPtr<ID3D12Resource> previous = replay.scratch;
      defer(context, [previous] {});
    }
    if (createBuffer(context, ScratchSize, D3D12_HEAP_TYPE_DEFAULT,
                     D3D12_RESOURCE_STATE_COMMON, &replay.scratch) != 0) {
      return -1;
    }
    replay.scratchUsed = 0;
    replay.scratchState = D3D12_RESOURCE_STATE_COMMON;
  }
  *slot = replay.scratchUsed;
  replay.scratchUsed += ScratchSlot;
  ID3D12Resource *scratch = replay.scratch.Get();
  auto transition = [&](D3D12_RESOURCE_STATES next) {
    D3D12_RESOURCE_BARRIER barrier{};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition = {scratch, D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                          replay.scratchState, next};
    replay.list->ResourceBarrier(1, &barrier);
    replay.scratchState = next;
  };
  transition(D3D12_RESOURCE_STATE_COPY_DEST);
  replay.list->CopyBufferRegion(scratch, *slot, buffer->resource.Get(),
                                offset, 12);
  replay.list->CopyBufferRegion(scratch, *slot + 12, buffer->resource.Get(),
                                offset, 12);
  transition(D3D12_RESOURCE_STATE_INDIRECT_ARGUMENT);
  return 0;
}

// The command signature of the indirect dispatches of a root signature:
// the root constants, then the dispatch.
ID3D12CommandSignature *dispatchSignature(fdw_dx_context *context,
                                          RootSignature *root) {
  if (!root->dispatch) {
    D3D12_INDIRECT_ARGUMENT_DESC arguments[2]{};
    arguments[0].Type = D3D12_INDIRECT_ARGUMENT_TYPE_CONSTANT;
    arguments[0].Constant = {0, 0, 3};
    arguments[1].Type = D3D12_INDIRECT_ARGUMENT_TYPE_DISPATCH;
    D3D12_COMMAND_SIGNATURE_DESC desc{24, 2, arguments, 0};
    const HRESULT result = context->device->CreateCommandSignature(
        &desc, root->signature.Get(), IID_PPV_ARGS(&root->dispatch));
    if (FAILED(result)) {
      fail("CreateCommandSignature", result);
      return nullptr;
    }
  }
  return root->dispatch.Get();
}

// A dispatch: the barriers of the groups bound and of the indirect buffer,
// in one call (a dispatch can read what the previous one wrote), then the
// groups and the dispatch.
int dispatch(Replay &replay, bool indirect) {
  int status = 0;
  Reader &reader = replay.reader;
  uint32_t workgroups[3] = {0, 0, 0};
  fdw_dx_buffer *buffer = nullptr;
  uint64_t offset = 0;
  if (indirect) {
    buffer = find(replay.context->buffers, reader.word(), "buffer", &status);
    offset = reader.wide();
    if (!buffer) {
      return status;
    }
  } else {
    for (uint32_t &count : workgroups) {
      count = reader.word();
    }
  }
  if (!replay.pipeline || !replay.pipeline->compute) {
    return fail("No compute pipeline set before dispatching");
  }
  {
    Barriers barriers{replay.context, replay.list};
    for (fdw_dx_group *group : replay.groups) {
      if (group && useGroup(replay, barriers, group) != 0) {
        return -1;
      }
    }
    if (buffer) {
      barriers.buffer(buffer, D3D12_RESOURCE_STATE_COPY_SOURCE);
    }
  }
  if (flushGroups(replay) != 0) {
    return -1;
  }
  if (!buffer) {
    replay.list->SetComputeRoot32BitConstants(0, 3, workgroups, 0);
    replay.list->Dispatch(workgroups[0], workgroups[1], workgroups[2]);
    return 0;
  }
  uint64_t slot = 0;
  ID3D12CommandSignature *signature =
      dispatchSignature(replay.context, replay.pipeline->root);
  if (!signature || indirectArguments(replay, buffer, offset, &slot) != 0) {
    return -1;
  }
  replay.list->ExecuteIndirect(signature, 1, replay.scratch.Get(), slot,
                               nullptr, 0);
  return 0;
}

// Binds the vertex buffers set, with the strides of the pipeline.
void flushVertexBuffers(Replay &replay) {
  if (!replay.vertexDirty) {
    return;
  }
  const std::vector<uint32_t> &strides = replay.pipeline->strides;
  for (uint32_t slot = 0; slot < strides.size() && slot < 16; slot++) {
    const fdw_dx_buffer *buffer = replay.vertexBuffers[slot];
    if (!buffer) {
      continue;
    }
    const D3D12_VERTEX_BUFFER_VIEW view{
        buffer->resource->GetGPUVirtualAddress(),
        static_cast<UINT>(buffer->size), strides[slot]};
    replay.list->IASetVertexBuffers(slot, 1, &view);
  }
  replay.vertexDirty = false;
}

int drawCommand(Replay &replay, uint32_t opcode) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_dx_context *context = replay.context;
  ID3D12GraphicsCommandList *list = replay.list;
  switch (opcode) {
  case FDW_DX_CMD_SET_PIPELINE: {
    fdw_dx_pipeline *pipeline =
        find(context->pipelines, reader.word(), "pipeline", &status);
    if (!pipeline) {
      return status;
    }
    if (pipeline->compute != replay.inComputePass) {
      return fail("A pipeline set in a pass of another kind");
    }
    if (pipeline->root != replay.root) {
      pipeline->compute
          ? list->SetComputeRootSignature(pipeline->root->signature.Get())
          : list->SetGraphicsRootSignature(pipeline->root->signature.Get());
      replay.root = pipeline->root;
      // The root arguments are lost with the root signature.
      replay.dirty.fill(true);
      replay.firstInstance = ~0u;
    }
    list->SetPipelineState(pipeline->state.Get());
    if (!pipeline->compute) {
      list->IASetPrimitiveTopology(pipeline->topology);
      // The strides are those of the pipeline.
      replay.vertexDirty = true;
    }
    replay.pipeline = pipeline;
    return 0;
  }
  case FDW_DX_CMD_SET_GROUP: {
    const uint32_t index = reader.word();
    fdw_dx_group *group = find(context->groups, reader.word(), "group", &status);
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
  case FDW_DX_CMD_SET_VERTEX_BUFFER: {
    const uint32_t slot = reader.word();
    fdw_dx_buffer *buffer =
        find(context->buffers, reader.word(), "buffer", &status);
    if (!buffer) {
      return status;
    }
    if (slot >= replay.vertexBuffers.size()) {
      return fail("Vertex buffer slot " + std::to_string(slot) +
                  " out of range");
    }
    replay.vertexBuffers[slot] = buffer;
    replay.vertexDirty = true;
    return 0;
  }
  case FDW_DX_CMD_SET_INDEX_BUFFER: {
    fdw_dx_buffer *buffer =
        find(context->buffers, reader.word(), "buffer", &status);
    const uint32_t format = reader.word();
    if (!buffer) {
      return status;
    }
    const D3D12_INDEX_BUFFER_VIEW view{
        buffer->resource->GetGPUVirtualAddress(),
        static_cast<UINT>(buffer->size),
        format == 0 ? DXGI_FORMAT_R16_UINT : DXGI_FORMAT_R32_UINT};
    list->IASetIndexBuffer(&view);
    return 0;
  }
  case FDW_DX_CMD_DISPATCH:
  case FDW_DX_CMD_DISPATCH_INDIRECT:
    if (!replay.inComputePass) {
      return fail("A dispatch outside of a compute pass");
    }
    return dispatch(replay, opcode == FDW_DX_CMD_DISPATCH_INDIRECT);
  case FDW_DX_CMD_DRAW:
  case FDW_DX_CMD_DRAW_INDEXED: {
    if (!replay.inRenderPass) {
      return fail("A draw outside of a render pass");
    }
    const uint32_t count = reader.word();
    const uint32_t instances = reader.word();
    const uint32_t firstInstance = reader.word();
    if (flushGroups(replay) != 0) {
      return -1;
    }
    flushVertexBuffers(replay);
    // SV_InstanceID starts at 0: the shaders add the first instance.
    if (firstInstance != replay.firstInstance) {
      list->SetGraphicsRoot32BitConstant(0, firstInstance, 0);
      replay.firstInstance = firstInstance;
    }
    if (opcode == FDW_DX_CMD_DRAW) {
      list->DrawInstanced(count, instances, 0, firstInstance);
    } else {
      list->DrawIndexedInstanced(count, instances, 0, 0, firstInstance);
    }
    return 0;
  }
  case FDW_DX_CMD_SET_VIEWPORT: {
    const float x = reader.real();
    const float y = reader.real();
    const float width = reader.real();
    const float height = reader.real();
    setViewport(list, x, y, width, height);
    return 0;
  }
  default:
    return fail("Unknown command " + std::to_string(opcode));
  }
}

int beginRenderPass(Replay &replay) {
  int status = 0;
  fdw_dx_context *context = replay.context;
  Reader &reader = replay.reader;
  const uint32_t colorCount = reader.word();
  if (colorCount > D3D12_SIMULTANEOUS_RENDER_TARGET_COUNT) {
    return fail("Too many color attachments");
  }
  struct Color {
    fdw_dx_texture *target;
    bool clear;
    float value[4];
  };
  std::vector<Color> colors;
  replay.resolves.clear();
  uint32_t width = 0;
  uint32_t height = 0;
  // The barriers of the pass, placed together before it.
  Barriers barriers{context, replay.list};
  for (uint32_t i = 0; i < colorCount; i++) {
    Color color{find(context->textures, reader.word(), "color target",
                     &status),
                reader.word() == 0};
    for (float &component : color.value) {
      component = reader.real();
    }
    const uint32_t resolveId = reader.word();
    if (!color.target) {
      return status;
    }
    if (color.target->rtv < 0) {
      return fail("The color target is not a render attachment");
    }
    barriers.texture(color.target, D3D12_RESOURCE_STATE_RENDER_TARGET);
    if (resolveId != 0) {
      fdw_dx_texture *resolve =
          find(context->textures, resolveId, "resolve target", &status);
      if (!resolve) {
        return status;
      }
      if (isIntegerFormat(color.target->format->target)) {
        return fail("Integer targets cannot be resolved on Direct3D 12");
      }
      replay.resolves.emplace_back(color.target, resolve);
    }
    width = color.target->width;
    height = color.target->height;
    colors.push_back(color);
  }

  const uint32_t depthId = reader.word();
  const bool clearDepth = reader.word() == 0;
  const float depthValue = reader.real();
  fdw_dx_texture *depth = nullptr;
  if (depthId != 0) {
    depth = find(context->textures, depthId, "depth target", &status);
    if (!depth) {
      return status;
    }
    if (depth->dsv < 0) {
      return fail("The depth target is not a render attachment");
    }
    barriers.texture(depth, D3D12_RESOURCE_STATE_DEPTH_WRITE);
    if (colorCount == 0) {
      width = depth->width;
      height = depth->height;
    }
  }
  if (reader.failed()) {
    return fail("Truncated render pass command");
  }
  if (prepareRenderPass(replay, barriers) != 0) {
    return -1;
  }
  barriers.place();

  ID3D12GraphicsCommandList *list = replay.list;
  std::vector<D3D12_CPU_DESCRIPTOR_HANDLE> targets;
  for (const Color &color : colors) {
    targets.push_back(
        context->rtvs.cpu(static_cast<uint32_t>(color.target->rtv)));
  }
  D3D12_CPU_DESCRIPTOR_HANDLE depthView{};
  if (depth) {
    depthView = context->dsvs.cpu(static_cast<uint32_t>(depth->dsv));
  }
  list->OMSetRenderTargets(colorCount, targets.data(), FALSE,
                           depth ? &depthView : nullptr);
  for (uint32_t i = 0; i < colorCount; i++) {
    // Integer formats take the values converted.
    if (colors[i].clear) {
      list->ClearRenderTargetView(targets[i], colors[i].value, 0, nullptr);
    }
  }
  if (depth && clearDepth) {
    list->ClearDepthStencilView(
        depthView,
        D3D12_CLEAR_FLAG_DEPTH |
            (depth->format->stencil ? D3D12_CLEAR_FLAG_STENCIL
                                    : D3D12_CLEAR_FLAGS(0)),
        depthValue, 0, 0, nullptr);
  }
  setViewport(list, 0, 0, static_cast<float>(width),
              static_cast<float>(height));
  replay.inRenderPass = true;
  return 0;
}

// The end of a render pass: the multisampled targets are resolved.
void endRenderPass(Replay &replay) {
  replay.inRenderPass = false;
  if (replay.resolves.empty()) {
    return;
  }
  {
    Barriers barriers{replay.context, replay.list};
    for (const auto &[target, resolve] : replay.resolves) {
      barriers.texture(target, D3D12_RESOURCE_STATE_RESOLVE_SOURCE);
      barriers.texture(resolve, D3D12_RESOURCE_STATE_RESOLVE_DEST);
    }
  }
  for (const auto &[target, resolve] : replay.resolves) {
    replay.list->ResolveSubresource(resolve->resource.Get(), 0,
                                    target->resource.Get(), 0,
                                    resolve->format->target);
  }
  replay.resolves.clear();
}

int copyBuffer(Replay &replay) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_dx_buffer *source =
      find(replay.context->buffers, reader.word(), "buffer", &status);
  const uint64_t sourceOffset = reader.wide();
  fdw_dx_buffer *destination =
      find(replay.context->buffers, reader.word(), "buffer", &status);
  const uint64_t destinationOffset = reader.wide();
  const uint64_t size = reader.wide();
  if (!source || !destination) {
    return status;
  }
  {
    // Both barriers in one call.
    Barriers barriers{replay.context, replay.list};
    barriers.buffer(source, D3D12_RESOURCE_STATE_COPY_SOURCE);
    barriers.buffer(destination, D3D12_RESOURCE_STATE_COPY_DEST);
  }
  replay.list->CopyBufferRegion(destination->resource.Get(), destinationOffset,
                                source->resource.Get(), sourceOffset, size);
  return 0;
}

int copyTexture(Replay &replay) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_dx_texture *source =
      find(replay.context->textures, reader.word(), "texture", &status);
  fdw_dx_texture *destination =
      find(replay.context->textures, reader.word(), "texture", &status);
  const uint32_t width = reader.word();
  const uint32_t height = reader.word();
  if (!source || !destination) {
    return status;
  }
  {
    // Both barriers in one call.
    Barriers barriers{replay.context, replay.list};
    barriers.texture(source, D3D12_RESOURCE_STATE_COPY_SOURCE);
    barriers.texture(destination, D3D12_RESOURCE_STATE_COPY_DEST);
  }
  D3D12_TEXTURE_COPY_LOCATION to{destination->resource.Get(),
                                 D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
  D3D12_TEXTURE_COPY_LOCATION from{source->resource.Get(),
                                   D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX};
  // Depth and multisampled textures are copied whole.
  const bool whole = source->format->depth || source->samples > 1;
  const D3D12_BOX box{0, 0, 0, width, height, 1};
  replay.list->CopyTextureRegion(&to, 0, 0, 0, &from, whole ? nullptr : &box);
  return 0;
}

// Resets timestamp queries, or writes one: the time when the commands
// before it are complete, resolved at once into the read back buffer.
int queryCommand(Replay &replay, uint32_t opcode) {
  int status = 0;
  Reader &reader = replay.reader;
  fdw_dx_query_pool *pool =
      find(replay.context->queryPools, reader.word(), "query pool", &status);
  const uint32_t first = reader.word();
  const uint32_t count =
      opcode == FDW_DX_CMD_RESET_QUERIES ? reader.word() : 1;
  if (!pool) {
    return status;
  }
  if (first + count > pool->count) {
    return fail("Queries out of the pool");
  }
  if (opcode == FDW_DX_CMD_RESET_QUERIES) {
    std::fill(pool->resolved.begin() + first,
              pool->resolved.begin() + first + count, 0);
    return 0;
  }
  replay.list->EndQuery(pool->heap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, first);
  replay.list->ResolveQueryData(pool->heap.Get(), D3D12_QUERY_TYPE_TIMESTAMP,
                                first, 1, pool->readback.Get(),
                                uint64_t(first) * 8);
  // Submitted with this list.
  pool->resolved[first] = replay.context->submitted + 1;
  return 0;
}

int replayCommands(Replay &replay) {
  while (!replay.reader.done()) {
    const uint32_t opcode = replay.reader.word();
    int status = 0;
    switch (opcode) {
    case FDW_DX_CMD_BEGIN_RENDER_PASS:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("A pass is already open");
      }
      status = beginRenderPass(replay);
      break;
    case FDW_DX_CMD_END_RENDER_PASS:
      if (!replay.inRenderPass) {
        return fail("No render pass to end");
      }
      endRenderPass(replay);
      break;
    case FDW_DX_CMD_BEGIN_COMPUTE_PASS:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("A pass is already open");
      }
      replay.inComputePass = true;
      break;
    case FDW_DX_CMD_END_COMPUTE_PASS:
      if (!replay.inComputePass) {
        return fail("No compute pass to end");
      }
      replay.inComputePass = false;
      break;
    case FDW_DX_CMD_RESET_QUERIES:
    case FDW_DX_CMD_WRITE_TIMESTAMP:
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("Timestamps are outside of the passes");
      }
      status = queryCommand(replay, opcode);
      break;
    case FDW_DX_CMD_COPY_BUFFER:
      status = copyBuffer(replay);
      break;
    case FDW_DX_CMD_COPY_TEXTURE:
      status = copyTexture(replay);
      break;
    case FDW_DX_CMD_GENERATE_MIPMAPS: {
      if (replay.inRenderPass || replay.inComputePass) {
        return fail("Mipmaps are computed outside of the passes");
      }
      fdw_dx_texture *texture = find(replay.context->textures,
                                     replay.reader.word(), "texture", &status);
      if (texture) {
        status = generateMipmaps(replay.context, replay.list, texture);
      }
      // It set its own root signature and pipeline.
      replay.root = nullptr;
      replay.pipeline = nullptr;
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

int fdw_dx_submit(fdw_dx_context *context, const uint32_t *words,
                  size_t count) {
  CommandList *list = beginList(context);
  if (!list) {
    return -1;
  }
  Replay replay{context, list->list.Get(), Reader(words, count)};
  const int status = replayCommands(replay);
  // On error, what was recorded is still submitted: the tracked state of
  // the resources is that of the commands recorded, which must then run.
  const std::string error = status != 0 ? fdw_dx_last_error() : "";
  if (replay.scratch) {
    ComPtr<ID3D12Resource> scratch = replay.scratch;
    defer(context, [scratch] {});
  }
  const uint64_t submission = submit(context, list);
  collect(context);
  if (submission == 0) {
    return -1;
  }
  return status != 0 ? fail(error) : 0;
}

} // extern "C"
