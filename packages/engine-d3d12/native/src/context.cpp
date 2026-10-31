// The context: device, queue, submissions, deferred destruction, upload
// memory, descriptor heaps and the messages of the debug layer.

#include "context.hpp"

#include <algorithm>
#include <cstring>

using namespace fdw;

namespace {

thread_local std::string lastError;

// The descriptors of the groups: shader visible heaps, as large as every
// GPU allows (1 000 000 views, 2048 samplers).
constexpr uint32_t ViewCount = 500000;
constexpr uint32_t SamplerCount = 2048;
constexpr uint32_t TargetCount = 4096;

// The upload memory comes in chunks of at least 8 MB.
constexpr uint64_t UploadChunkSize = 8ull << 20;

std::string utf8(const wchar_t *text) {
  const int length =
      WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  std::string result(length > 0 ? length - 1 : 0, '\0');
  if (length > 1) {
    WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), length, nullptr,
                        nullptr);
  }
  return result;
}

std::wstring wide(const char *text) {
  const int length = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
  std::wstring result(length > 0 ? length - 1 : 0, L'\0');
  if (length > 1) {
    MultiByteToWideChar(CP_UTF8, 0, text, -1, result.data(), length);
  }
  return result;
}

// The high performance adapter with Direct3D 12, not a software one.
int chooseAdapter(fdw_dx_context *context) {
  ComPtr<IDXGIFactory6> factory6;
  context->factory.As(&factory6);
  for (UINT index = 0;; index++) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT result =
        factory6 ? factory6->EnumAdapterByGpuPreference(
                       index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                       IID_PPV_ARGS(&adapter))
                 : context->factory->EnumAdapters1(index, &adapter);
    if (result == DXGI_ERROR_NOT_FOUND) {
      break;
    }
    if (FAILED(result)) {
      continue;
    }
    DXGI_ADAPTER_DESC1 desc{};
    adapter->GetDesc1(&desc);
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) {
      continue;
    }
    if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0,
                                    __uuidof(ID3D12Device), nullptr))) {
      context->adapter = adapter;
      context->deviceName = utf8(desc.Description);
      return 0;
    }
  }
  return fail("No GPU with Direct3D 12 was found");
}

// The messages of the debug layer that are not about the engine.
void filterMessages(ID3D12InfoQueue *queue) {
  D3D12_MESSAGE_SEVERITY severities[] = {D3D12_MESSAGE_SEVERITY_INFO,
                                         D3D12_MESSAGE_SEVERITY_MESSAGE};
  D3D12_MESSAGE_ID ids[] = {
      // Clear values different from the optimized ones: none are given.
      D3D12_MESSAGE_ID_CLEARRENDERTARGETVIEW_MISMATCHINGCLEARVALUE,
      D3D12_MESSAGE_ID_CLEARDEPTHSTENCILVIEW_MISMATCHINGCLEARVALUE,
  };
  D3D12_INFO_QUEUE_FILTER filter{};
  filter.DenyList.NumSeverities = _countof(severities);
  filter.DenyList.pSeverityList = severities;
  filter.DenyList.NumIDs = _countof(ids);
  filter.DenyList.pIDList = ids;
  queue->PushStorageFilter(&filter);
  queue->SetMessageCountLimit(4096);
}

int createDevice(fdw_dx_context *context, bool validation) {
  UINT factoryFlags = 0;
  if (validation) {
    // The debug layer, when the Graphics Tools of Windows are installed.
    ComPtr<ID3D12Debug> debug;
    if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
      debug->EnableDebugLayer();
      context->validation = true;
      factoryFlags |= DXGI_CREATE_FACTORY_DEBUG;
    }
  }
  HRESULT result =
      CreateDXGIFactory2(factoryFlags, IID_PPV_ARGS(&context->factory));
  if (FAILED(result) && factoryFlags) {
    result = CreateDXGIFactory2(0, IID_PPV_ARGS(&context->factory));
  }
  if (FAILED(result)) {
    return fail("CreateDXGIFactory2", result);
  }
  if (chooseAdapter(context) != 0) {
    return -1;
  }
  result = D3D12CreateDevice(context->adapter.Get(), D3D_FEATURE_LEVEL_11_0,
                             IID_PPV_ARGS(&context->device));
  if (FAILED(result)) {
    return fail("D3D12CreateDevice", result);
  }
  D3D12_FEATURE_DATA_SHADER_MODEL model{D3D_SHADER_MODEL_6_0};
  if (FAILED(context->device->CheckFeatureSupport(
          D3D12_FEATURE_SHADER_MODEL, &model, sizeof(model))) ||
      model.HighestShaderModel < D3D_SHADER_MODEL_6_0) {
    return fail("The GPU has no Shader Model 6.0");
  }
  // Ray queries and ray tracing pipelines: DXR 1.1 and Shader Model 6.5.
  D3D12_FEATURE_DATA_D3D12_OPTIONS5 options5{};
  D3D12_FEATURE_DATA_SHADER_MODEL rayModel{D3D_SHADER_MODEL_6_5};
  if (SUCCEEDED(context->device->CheckFeatureSupport(
          D3D12_FEATURE_D3D12_OPTIONS5, &options5, sizeof(options5))) &&
      options5.RaytracingTier >= D3D12_RAYTRACING_TIER_1_1 &&
      SUCCEEDED(context->device->CheckFeatureSupport(
          D3D12_FEATURE_SHADER_MODEL, &rayModel, sizeof(rayModel))) &&
      rayModel.HighestShaderModel >= D3D_SHADER_MODEL_6_5 &&
      SUCCEEDED(context->device.As(&context->rayDevice))) {
    context->rayQuery = true;
  }
  if (context->validation &&
      SUCCEEDED(context->device.As(&context->infoQueue))) {
    filterMessages(context->infoQueue.Get());
  }

  D3D12_COMMAND_QUEUE_DESC queue{};
  queue.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
  result = context->device->CreateCommandQueue(&queue,
                                               IID_PPV_ARGS(&context->queue));
  if (FAILED(result)) {
    return fail("CreateCommandQueue", result);
  }
  UINT64 frequency = 0;
  if (SUCCEEDED(context->queue->GetTimestampFrequency(&frequency))) {
    context->timestampFrequency = frequency;
  }
  result = context->device->CreateFence(0, D3D12_FENCE_FLAG_NONE,
                                        IID_PPV_ARGS(&context->fence));
  if (FAILED(result)) {
    return fail("CreateFence", result);
  }
  context->fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  ComPtr<IDXGIFactory5> factory5;
  BOOL tearing = FALSE;
  if (SUCCEEDED(context->factory.As(&factory5)) &&
      SUCCEEDED(factory5->CheckFeatureSupport(
          DXGI_FEATURE_PRESENT_ALLOW_TEARING, &tearing, sizeof(tearing)))) {
    context->tearing = tearing != FALSE;
  }

  ID3D12Device *device = context->device.Get();
  if (context->views.create(device, D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV,
                            ViewCount, true) != 0 ||
      context->samplerHeap.create(device, D3D12_DESCRIPTOR_HEAP_TYPE_SAMPLER,
                                  SamplerCount, true) != 0 ||
      context->rtvs.create(device, D3D12_DESCRIPTOR_HEAP_TYPE_RTV,
                           TargetCount, false) != 0 ||
      context->dsvs.create(device, D3D12_DESCRIPTOR_HEAP_TYPE_DSV,
                           TargetCount, false) != 0) {
    return -1;
  }
  return 0;
}

} // namespace

namespace fdw {

int fail(const std::string &message) {
  lastError = message;
  return -1;
}

int fail(const char *call, HRESULT result) {
  char code[16];
  std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(result));
  return fail(std::string(call) + " failed (" + code + ")");
}

bool readOnly(D3D12_RESOURCE_STATES state) {
  constexpr D3D12_RESOURCE_STATES reads =
      D3D12_RESOURCE_STATE_VERTEX_AND_CONSTANT_BUFFER |
      D3D12_RESOURCE_STATE_INDEX_BUFFER |
      D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE |
      D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE |
      D3D12_RESOURCE_STATE_INDIRECT_ARGUMENT |
      D3D12_RESOURCE_STATE_COPY_SOURCE | D3D12_RESOURCE_STATE_DEPTH_READ |
      D3D12_RESOURCE_STATE_RESOLVE_SOURCE;
  return state != D3D12_RESOURCE_STATE_COMMON && (state & ~reads) == 0;
}

int DescriptorHeap::create(ID3D12Device *device,
                           D3D12_DESCRIPTOR_HEAP_TYPE type, uint32_t count,
                           bool shaderVisible) {
  D3D12_DESCRIPTOR_HEAP_DESC desc{};
  desc.Type = type;
  desc.NumDescriptors = count;
  desc.Flags = shaderVisible ? D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE
                             : D3D12_DESCRIPTOR_HEAP_FLAG_NONE;
  const HRESULT result =
      device->CreateDescriptorHeap(&desc, IID_PPV_ARGS(&heap));
  if (FAILED(result)) {
    return fail("CreateDescriptorHeap", result);
  }
  increment = device->GetDescriptorHandleIncrementSize(type);
  capacity = count;
  cpuStart = heap->GetCPUDescriptorHandleForHeapStart();
  if (shaderVisible) {
    gpuStart = heap->GetGPUDescriptorHandleForHeapStart();
  }
  free[0] = count;
  return 0;
}

int64_t DescriptorHeap::allocate(uint32_t count) {
  for (auto range = free.begin(); range != free.end(); ++range) {
    if (range->second < count) {
      continue;
    }
    const uint32_t first = range->first;
    const uint32_t left = range->second - count;
    free.erase(range);
    if (left > 0) {
      free[first + count] = left;
    }
    return first;
  }
  return -1;
}

void DescriptorHeap::release(uint32_t first, uint32_t count) {
  if (count == 0) {
    return;
  }
  auto next = free.lower_bound(first);
  // Merged with the free ranges around it.
  if (next != free.end() && first + count == next->first) {
    count += next->second;
    next = free.erase(next);
  }
  if (next != free.begin()) {
    auto previous = std::prev(next);
    if (previous->first + previous->second == first) {
      previous->second += count;
      return;
    }
  }
  free[first] = count;
}

CommandList *beginList(fdw_dx_context *context) {
  const uint64_t done = completed(context);
  CommandList *chosen = nullptr;
  for (auto &candidate : context->lists) {
    if (!candidate->recording && candidate->submission <= done) {
      chosen = candidate.get();
      break;
    }
  }
  ID3D12Device *device = context->device.Get();
  if (chosen) {
    chosen->allocator->Reset();
    chosen->list->Reset(chosen->allocator.Get(), nullptr);
  } else {
    auto list = std::make_unique<CommandList>();
    HRESULT result = device->CreateCommandAllocator(
        D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&list->allocator));
    if (SUCCEEDED(result)) {
      result = device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT,
                                         list->allocator.Get(), nullptr,
                                         IID_PPV_ARGS(&list->list));
    }
    if (SUCCEEDED(result) && context->rayQuery) {
      result = list->list.As(&list->rays);
    }
    if (FAILED(result)) {
      fail("CreateCommandList", result);
      return nullptr;
    }
    chosen = list.get();
    context->lists.push_back(std::move(list));
  }
  chosen->recording = true;
  ID3D12DescriptorHeap *heaps[] = {context->views.heap.Get(),
                                   context->samplerHeap.heap.Get()};
  chosen->list->SetDescriptorHeaps(2, heaps);
  // The buffers start in the common state.
  context->epoch++;
  return chosen;
}

ID3D12GraphicsCommandList *transfers(fdw_dx_context *context) {
  if (!context->transfers) {
    context->transfers = beginList(context);
  }
  return context->transfers ? context->transfers->list.Get() : nullptr;
}

uint64_t submit(fdw_dx_context *context, CommandList *list) {
  // Each list in its own execution: the buffers decay to the common state
  // between them, as the tracking expects.
  std::vector<CommandList *> executed;
  if (context->transfers) {
    executed.push_back(context->transfers);
    context->transfers = nullptr;
  }
  if (list) {
    executed.push_back(list);
  }
  bool failed = false;
  for (CommandList *entry : executed) {
    entry->recording = false;
    const HRESULT result = entry->list->Close();
    if (FAILED(result)) {
      fail("Closing a command list", result);
      failed = true;
      continue;
    }
    ID3D12CommandList *lists[] = {entry->list.Get()};
    context->queue->ExecuteCommandLists(1, lists);
  }
  const uint64_t value = context->submitted + 1;
  const HRESULT result = context->queue->Signal(context->fence.Get(), value);
  takeDebugMessages(context);
  if (FAILED(result)) {
    fail("Signal", result);
    return 0;
  }
  context->submitted = value;
  for (CommandList *entry : executed) {
    entry->submission = value;
  }
  return failed ? 0 : value;
}

uint64_t completed(fdw_dx_context *context) {
  return context->fence->GetCompletedValue();
}

int waitFor(fdw_dx_context *context, uint64_t submission) {
  if (completed(context) >= submission) {
    return 0;
  }
  const HRESULT result =
      context->fence->SetEventOnCompletion(submission, context->fenceEvent);
  if (FAILED(result)) {
    return fail("SetEventOnCompletion", result);
  }
  WaitForSingleObject(context->fenceEvent, INFINITE);
  return 0;
}

void collect(fdw_dx_context *context) {
  const uint64_t done = completed(context);
  std::vector<Deferred> remaining;
  // Run in order; the work can defer more.
  std::vector<Deferred> ready;
  for (Deferred &entry : context->deferred) {
    (entry.submission <= done ? ready : remaining).push_back(std::move(entry));
  }
  context->deferred = std::move(remaining);
  for (Deferred &entry : ready) {
    entry.run();
  }
}

void defer(fdw_dx_context *context, std::function<void()> run) {
  // The commands being recorded (transfers, or a submission being
  // replayed) may use the object: after the next submission.
  context->deferred.push_back({context->submitted + 1, std::move(run)});
}

void setName(ID3D12Object *object, const char *name) {
  if (object && name && *name) {
    object->SetName(wide(name).c_str());
  }
}

void takeDebugMessages(fdw_dx_context *context) {
  ID3D12InfoQueue *queue = context->infoQueue.Get();
  if (!queue) {
    return;
  }
  const UINT64 count = queue->GetNumStoredMessagesAllowedByRetrievalFilter();
  for (UINT64 i = 0; i < count; i++) {
    SIZE_T length = 0;
    queue->GetMessage(i, nullptr, &length);
    std::vector<uint8_t> storage(length);
    auto *message = reinterpret_cast<D3D12_MESSAGE *>(storage.data());
    if (SUCCEEDED(queue->GetMessage(i, message, &length))) {
      const char *severity =
          message->Severity == D3D12_MESSAGE_SEVERITY_WARNING ? "warning"
                                                              : "error";
      context->messages.push_back(std::string("D3D12 ") + severity + ": " +
                                  std::string(message->pDescription,
                                              message->DescriptionByteLength
                                                  ? message->DescriptionByteLength - 1
                                                  : 0));
    }
  }
  queue->ClearStoredMessages();
}

int createBuffer(fdw_dx_context *context, uint64_t size, D3D12_HEAP_TYPE heap,
                 D3D12_RESOURCE_STATES state,
                 ComPtr<ID3D12Resource> *result) {
  D3D12_HEAP_PROPERTIES properties{heap};
  D3D12_RESOURCE_DESC desc{};
  desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
  desc.Width = std::max<uint64_t>(size, 4);
  desc.Height = 1;
  desc.DepthOrArraySize = 1;
  desc.MipLevels = 1;
  desc.SampleDesc.Count = 1;
  desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
  const HRESULT status = context->device->CreateCommittedResource(
      &properties, D3D12_HEAP_FLAG_NONE, &desc, state, nullptr,
      IID_PPV_ARGS(result->ReleaseAndGetAddressOf()));
  return FAILED(status) ? fail("CreateCommittedResource", status) : 0;
}

int upload(fdw_dx_context *context, uint64_t size, uint64_t alignment,
           Upload *result) {
  // Recorded with the transfers: the chunk is used until their submission.
  const uint64_t submission = context->submitted + 1;
  auto take = [&](UploadChunk &chunk) {
    const uint64_t offset = (chunk.used + alignment - 1) / alignment * alignment;
    if (offset + size > chunk.size) {
      return false;
    }
    chunk.used = offset + size;
    chunk.submission = submission;
    *result = {chunk.resource.Get(), offset, chunk.mapped + offset};
    return true;
  };
  if (context->upload < context->uploads.size() &&
      take(context->uploads[context->upload])) {
    return 0;
  }
  // A chunk the GPU no longer reads, else a new one.
  const uint64_t done = completed(context);
  for (size_t i = 0; i < context->uploads.size(); i++) {
    UploadChunk &chunk = context->uploads[i];
    if (chunk.submission <= done && chunk.size >= size) {
      chunk.used = 0;
      context->upload = i;
      take(chunk);
      return 0;
    }
  }
  UploadChunk chunk;
  chunk.size = std::max(UploadChunkSize, (size + 0xFFFF) & ~0xFFFFull);
  if (createBuffer(context, chunk.size, D3D12_HEAP_TYPE_UPLOAD,
                   D3D12_RESOURCE_STATE_GENERIC_READ, &chunk.resource) != 0) {
    return -1;
  }
  const D3D12_RANGE none{0, 0};
  void *mapped = nullptr;
  const HRESULT status = chunk.resource->Map(0, &none, &mapped);
  if (FAILED(status)) {
    return fail("Mapping upload memory", status);
  }
  chunk.mapped = static_cast<uint8_t *>(mapped);
  context->uploads.push_back(std::move(chunk));
  context->upload = context->uploads.size() - 1;
  take(context->uploads.back());
  return 0;
}

uint64_t addRead(fdw_dx_context *context, PendingRead read) {
  const uint64_t ticket = context->nextTicket++;
  context->reads[ticket] = std::move(read);
  return ticket;
}

} // namespace fdw

extern "C" {

const char *fdw_dx_last_error(void) { return lastError.c_str(); }

fdw_dx_context *fdw_dx_context_create(const fdw_dx_context_options *options) {
  auto *context = new fdw_dx_context();
  if (createDevice(context, options && options->validation) != 0) {
    const std::string error = lastError;
    fdw_dx_context_destroy(context);
    fail(error);
    return nullptr;
  }
  return context;
}

void fdw_dx_context_destroy(fdw_dx_context *context) {
  if (!context) {
    return;
  }
  if (context->device && context->queue && context->fence) {
    fdw_dx_wait_idle(context);
    // Everything still deferred can run: the GPU is idle.
    for (Deferred &entry : context->deferred) {
      entry.run();
    }
    context->deferred.clear();
    context->reads.clear();
    destroySwapchains(context);
    destroyPipelines(context);
    destroyAccelerationStructures(context);
    for (auto &[id, buffer] : context->buffers) {
      delete buffer;
    }
    context->buffers.clear();
    for (auto &[id, texture] : context->textures) {
      destroyTexture(context, texture);
    }
    context->textures.clear();
    for (auto &[id, sampler] : context->samplers) {
      delete sampler;
    }
    context->samplers.clear();
    for (auto &[id, pool] : context->queryPools) {
      delete pool;
    }
    context->queryPools.clear();
  }
  if (context->fenceEvent) {
    CloseHandle(context->fenceEvent);
  }
  delete context;
}

const char *fdw_dx_device_name(const fdw_dx_context *context) {
  return context->deviceName.c_str();
}

int32_t fdw_dx_validation_enabled(const fdw_dx_context *context) {
  return context->validation ? 1 : 0;
}

int fdw_dx_wait_idle(fdw_dx_context *context) {
  // A new signal, after everything in the queue: the presentations too,
  // queued after the submission of their frame.
  const uint64_t last = submit(context);
  if (last == 0 || waitFor(context, last) != 0) {
    return -1;
  }
  collect(context);
  return 0;
}

int fdw_dx_flush(fdw_dx_context *context) {
  if (context->transfers && submit(context) == 0) {
    return -1;
  }
  collect(context);
  return 0;
}

size_t fdw_dx_message_count(fdw_dx_context *context) {
  takeDebugMessages(context);
  return context->messages.size();
}

const char *fdw_dx_message(const fdw_dx_context *context, size_t index) {
  return index < context->messages.size() ? context->messages[index].c_str()
                                          : "";
}

void fdw_dx_clear_messages(fdw_dx_context *context) {
  context->messages.clear();
}

int fdw_dx_read_ready(fdw_dx_context *context, uint64_t ticket) {
  const auto found = context->reads.find(ticket);
  if (found == context->reads.end()) {
    return fail("Unknown read ticket " + std::to_string(ticket));
  }
  collect(context);
  return completed(context) >= found->second.submission ? 1 : 0;
}

int fdw_dx_read_take(fdw_dx_context *context, uint64_t ticket, void *data,
                     uint64_t size) {
  const auto found = context->reads.find(ticket);
  if (found == context->reads.end()) {
    return fail("Unknown read ticket " + std::to_string(ticket));
  }
  const PendingRead &read = found->second;
  if (completed(context) < read.submission) {
    return fail("The read is not ready");
  }
  const uint64_t available = read.rowSize * read.rows;
  if (size > available) {
    return fail("The read has only " + std::to_string(available) + " bytes");
  }
  const uint64_t end = read.offset + read.pitch * (read.rows - 1) + read.rowSize;
  const D3D12_RANGE range{0, static_cast<SIZE_T>(end)};
  void *mapped = nullptr;
  const HRESULT result = read.readback->Map(0, &range, &mapped);
  if (FAILED(result)) {
    return fail("Mapping a read back buffer", result);
  }
  // The rows, without the padding of the copy.
  auto *target = static_cast<uint8_t *>(data);
  const auto *source = static_cast<const uint8_t *>(mapped) + read.offset;
  uint64_t left = size;
  for (uint32_t row = 0; row < read.rows && left > 0; row++) {
    const uint64_t count = std::min(left, read.rowSize);
    std::memcpy(target, source + row * read.pitch, count);
    target += count;
    left -= count;
  }
  const D3D12_RANGE none{0, 0};
  read.readback->Unmap(0, &none);
  context->reads.erase(found);
  return 0;
}

} // extern "C"
