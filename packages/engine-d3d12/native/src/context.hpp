// Internal state of the Direct3D 12 library (include/fdw/d3d12.h).

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "fdw/d3d12.h"

using Microsoft::WRL::ComPtr;

namespace fdw {

// The last error of the thread, read by fdw_dx_last_error.
int fail(const std::string &message);
// A failed Direct3D call: its name and result.
int fail(const char *call, HRESULT result);

// Something to do once the GPU has finished a submission: free a staging
// buffer, recycle a command list, destroy a resource.
struct Deferred {
  uint64_t submission;
  std::function<void()> run;
};

// A range read back: copied into `readback` by `submission`, as `rows`
// rows of `rowSize` bytes, `pitch` bytes apart, from `offset`.
struct PendingRead {
  uint64_t submission;
  ComPtr<ID3D12Resource> readback;
  uint64_t offset = 0;
  uint64_t pitch = 0;
  uint64_t rowSize = 0;
  uint32_t rows = 1;
};

// A heap of descriptors, allocated by ranges (first fit), freed once the
// GPU no longer uses them.
struct DescriptorHeap {
  ComPtr<ID3D12DescriptorHeap> heap;
  uint32_t increment = 0;
  uint32_t capacity = 0;
  D3D12_CPU_DESCRIPTOR_HANDLE cpuStart{};
  D3D12_GPU_DESCRIPTOR_HANDLE gpuStart{};
  // The free ranges: first descriptor, count.
  std::map<uint32_t, uint32_t> free;

  int create(ID3D12Device *device, D3D12_DESCRIPTOR_HEAP_TYPE type,
             uint32_t count, bool shaderVisible);
  // The first descriptor of `count` consecutive ones, or -1 when full.
  int64_t allocate(uint32_t count);
  void release(uint32_t first, uint32_t count);
  D3D12_CPU_DESCRIPTOR_HANDLE cpu(uint32_t index) const {
    return {cpuStart.ptr + static_cast<SIZE_T>(index) * increment};
  }
  D3D12_GPU_DESCRIPTOR_HANDLE gpu(uint32_t index) const {
    return {gpuStart.ptr + static_cast<UINT64>(index) * increment};
  }
};

// A command list and its allocator, reused once its submission is done.
struct CommandList {
  ComPtr<ID3D12CommandAllocator> allocator;
  ComPtr<ID3D12GraphicsCommandList> list;
  uint64_t submission = 0;
  bool recording = false;
};

// A chunk of upload memory, mapped, used linearly by the writes until its
// last submission is done.
struct UploadChunk {
  ComPtr<ID3D12Resource> resource;
  uint8_t *mapped = nullptr;
  uint64_t size = 0;
  uint64_t used = 0;
  uint64_t submission = 0;
};

// A place in the upload memory.
struct Upload {
  ID3D12Resource *resource = nullptr;
  uint64_t offset = 0;
  uint8_t *data = nullptr;
};

// A texture format of the engine. The compressed formats store blocks of
// block × block pixels, of pixelSize bytes. Depth formats have a typeless
// resource, a depth view (dsv) and a shader view (srv).
struct FormatInfo {
  const char *name;
  DXGI_FORMAT resource;
  DXGI_FORMAT srv;
  DXGI_FORMAT target;
  uint32_t pixelSize;
  bool depth = false;
  bool stencil = false;
  uint32_t block = 1;
};
const FormatInfo *findFormat(const char *name);

// Whether a state only reads (several can be combined).
bool readOnly(D3D12_RESOURCE_STATES state);

} // namespace fdw

struct fdw_dx_buffer {
  uint32_t id = 0;
  ComPtr<ID3D12Resource> resource;
  uint64_t size = 0;
  // The size allocated: a multiple of 256 bytes, as constant buffer views
  // need.
  uint64_t allocated = 0;
  // The state, valid in the command list of `epoch` only: buffers decay to
  // the common state between the executions of command lists.
  D3D12_RESOURCE_STATES state = D3D12_RESOURCE_STATE_COMMON;
  uint64_t epoch = 0;
  // Written as an unordered access view since its last barrier.
  bool unorderedWrite = false;
};

struct fdw_dx_texture {
  uint32_t id = 0;
  ComPtr<ID3D12Resource> resource;
  const fdw::FormatInfo *format = nullptr;
  // "2d", "2d-array", "3d" or "cube".
  std::string type = "2d";
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t layers = 1;
  // Levels of detail.
  uint32_t levels = 1;
  uint32_t samples = 1;
  bool is3d = false;
  // An image of a swapchain: owned by it, not destroyed as a texture.
  bool external = false;
  // The render target or depth view of the first level of the first layer,
  // in the heaps of the context (-1: none).
  int64_t rtv = -1;
  int64_t dsv = -1;
  // The state of every subresource.
  D3D12_RESOURCE_STATES state = D3D12_RESOURCE_STATE_COMMON;
};

struct fdw_dx_sampler {
  uint32_t id = 0;
  D3D12_SAMPLER_DESC desc{};
};

struct fdw_dx_shader {
  std::vector<uint8_t> bytecode;
  // 'v', 'p' or 'c': the stage of its profile.
  char stage = 'v';
};

struct fdw_dx_group_layout {
  uint32_t id = 0;
  std::vector<fdw_dx_layout_binding> bindings;
  // The bindings in the descriptor tables: buffers and textures, then
  // samplers, in the order of the layout.
  std::vector<fdw_dx_layout_binding> resources;
  std::vector<fdw_dx_layout_binding> samplers;
};

struct fdw_dx_group {
  uint32_t id = 0;
  const fdw_dx_group_layout *layout = nullptr;
  // The descriptors in the shader visible heaps (-1: none).
  int64_t resources = -1;
  int64_t samplers = -1;
  // The key of the shared sampler table.
  std::string samplerKey;
  // The resources, by id, with how the shaders use them: their barriers
  // are placed before the passes that use the group.
  std::vector<std::pair<fdw_dx_binding_kind, uint32_t>> used;
};

// A root signature: the root constants (b0 of the constants space), then
// for each group a table of its resources and a table of its samplers.
struct RootSignature {
  ComPtr<ID3D12RootSignature> signature;
  // The root parameter of the tables of each group (-1: none).
  std::vector<int32_t> resourceTables;
  std::vector<int32_t> samplerTables;
  // For the indirect dispatches: sets the root constants, then dispatches.
  ComPtr<ID3D12CommandSignature> dispatch;
};

struct fdw_dx_pipeline {
  uint32_t id = 0;
  ComPtr<ID3D12PipelineState> state;
  RootSignature *root = nullptr;
  bool compute = false;
  D3D_PRIMITIVE_TOPOLOGY topology = D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
  // The stride of each vertex buffer.
  std::vector<uint32_t> strides;
};

struct fdw_dx_query_pool {
  uint32_t id = 0;
  ComPtr<ID3D12QueryHeap> heap;
  ComPtr<ID3D12Resource> readback;
  const uint64_t *ticks = nullptr;
  uint32_t count = 0;
  // The submission that resolved each query (0: not yet written).
  std::vector<uint64_t> resolved;
};

struct fdw_dx_swapchain;

struct fdw_dx_context {
  bool validation = false;
  ComPtr<IDXGIFactory4> factory;
  ComPtr<IDXGIAdapter1> adapter;
  std::string deviceName;
  ComPtr<ID3D12Device> device;
  ComPtr<ID3D12InfoQueue> infoQueue;
  ComPtr<ID3D12CommandQueue> queue;
  // Ticks of the timestamps per second (0: no timestamps).
  uint64_t timestampFrequency = 0;
  bool tearing = false;

  // Every submission signals the next value of the fence: a submission is
  // complete when the fence reaches its value.
  ComPtr<ID3D12Fence> fence;
  HANDLE fenceEvent = nullptr;
  uint64_t submitted = 0;

  // The command lists, recycled. Each list recorded starts a new epoch:
  // the buffers are back in the common state.
  std::vector<std::unique_ptr<fdw::CommandList>> lists;
  uint64_t epoch = 0;
  // The transfer commands recorded since the last submission: buffer
  // writes and read back copies, in order. Begun on first use. Their
  // barriers are those of the tracking, as for the replayed commands.
  fdw::CommandList *transfers = nullptr;

  std::vector<fdw::UploadChunk> uploads;
  size_t upload = 0;

  std::vector<fdw::Deferred> deferred;
  std::map<uint64_t, fdw::PendingRead> reads;
  uint64_t nextTicket = 1;

  // The descriptor heaps: shader visible for the groups, CPU only for the
  // render targets and depth views.
  fdw::DescriptorHeap views;
  fdw::DescriptorHeap samplerHeap;
  fdw::DescriptorHeap rtvs;
  fdw::DescriptorHeap dsvs;
  // The sampler tables, shared by the groups with the same samplers.
  struct SamplerTable {
    int64_t first = -1;
    uint32_t count = 0;
    uint32_t users = 0;
  };
  std::map<std::string, SamplerTable> samplerTables;

  // The objects alive, by id; destroyed with the context.
  uint32_t nextId = 1;
  std::map<uint32_t, fdw_dx_buffer *> buffers;
  std::map<uint32_t, fdw_dx_texture *> textures;
  std::map<uint32_t, fdw_dx_sampler *> samplers;
  std::map<uint32_t, fdw_dx_group_layout *> groupLayouts;
  std::map<uint32_t, fdw_dx_group *> groups;
  std::map<uint32_t, fdw_dx_pipeline *> pipelines;
  std::map<uint32_t, fdw_dx_query_pool *> queryPools;
  std::set<fdw_dx_shader *> shaders;
  // The root signatures, by their groups.
  std::map<std::string, std::unique_ptr<RootSignature>> rootSignatures;

  // The computation of the levels of detail: a root signature, shaders, and
  // a pipeline per format.
  struct {
    ComPtr<ID3D12RootSignature> root;
    std::vector<uint8_t> vertex;
    std::vector<uint8_t> pixel;
    std::map<DXGI_FORMAT, ComPtr<ID3D12PipelineState>> pipelines;
  } mipmaps;

  std::vector<std::string> messages;
  std::set<fdw_dx_swapchain *> swapchains;
};

namespace fdw {

// The command list of the transfers, begun if needed.
ID3D12GraphicsCommandList *transfers(fdw_dx_context *context);
// A command list to record, with the heaps of the groups set: a new epoch.
CommandList *beginList(fdw_dx_context *context);
// Executes the transfers recorded, then the given command list, each in
// its own ExecuteCommandLists. Returns the submission, or 0 on error.
uint64_t submit(fdw_dx_context *context, CommandList *list = nullptr);
// The last submission the GPU has completed.
uint64_t completed(fdw_dx_context *context);
// Waits until the GPU has completed a submission.
int waitFor(fdw_dx_context *context, uint64_t submission);
// Runs the deferred work of the completed submissions.
void collect(fdw_dx_context *context);
// Runs `run` once the GPU no longer uses what was submitted so far, and
// what is being recorded (done by the next submission).
void defer(fdw_dx_context *context, std::function<void()> run);
// Gives a debug name to an object.
void setName(ID3D12Object *object, const char *name);
// Keeps the messages of the debug layer.
void takeDebugMessages(fdw_dx_context *context);

// Upload memory for the transfers to come, aligned.
int upload(fdw_dx_context *context, uint64_t size, uint64_t alignment,
           Upload *result);
// A buffer of a heap type (upload, readback), in its initial state.
int createBuffer(fdw_dx_context *context, uint64_t size, D3D12_HEAP_TYPE heap,
                 D3D12_RESOURCE_STATES state,
                 ComPtr<ID3D12Resource> *result);

// The barriers needed before a pass (render, compute, copy) or a transfer,
// gathered by texture() and buffer(), then placed together: one
// ResourceBarrier, at place() or at the end of the scope (an error return
// included: the tracked state already counts them).
struct Barriers {
  Barriers(fdw_dx_context *context, ID3D12GraphicsCommandList *list)
      : context(context), list(list) {}
  Barriers(const Barriers &) = delete;
  Barriers &operator=(const Barriers &) = delete;
  ~Barriers() { place(); }

  // The uses of a pass: read states are combined, a write wins.
  void texture(fdw_dx_texture *texture, D3D12_RESOURCE_STATES state);
  void buffer(fdw_dx_buffer *buffer, D3D12_RESOURCE_STATES state);
  void place();

  fdw_dx_context *context;
  ID3D12GraphicsCommandList *list;
  std::vector<std::pair<fdw_dx_texture *, D3D12_RESOURCE_STATES>> textures;
  std::vector<std::pair<fdw_dx_buffer *, D3D12_RESOURCE_STATES>> buffers;
};

// A single use, its barrier placed at once.
void useTexture(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
                fdw_dx_texture *texture, D3D12_RESOURCE_STATES state);
void useBuffer(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
               fdw_dx_buffer *buffer, D3D12_RESOURCE_STATES state);
// The state of a buffer in the command list being recorded.
D3D12_RESOURCE_STATES bufferState(const fdw_dx_context *context,
                                  const fdw_dx_buffer *buffer);
// The state the shaders read textures and storage buffers in.
constexpr D3D12_RESOURCE_STATES ShaderRead =
    D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE |
    D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE;

// Records the computation of the levels of a texture after the first one,
// each drawn from the previous one, in every layer.
int generateMipmaps(fdw_dx_context *context, ID3D12GraphicsCommandList *list,
                    fdw_dx_texture *texture);
// Compiles HLSL with the DXC library into DXIL.
int compileHlsl(const char *hlsl, const char *const *arguments,
                uint32_t count, std::vector<uint8_t> *bytecode);

// The root signature of pipelines with these groups (cached).
RootSignature *rootSignature(fdw_dx_context *context,
                             fdw_dx_group_layout *const *groups,
                             uint32_t count, bool compute);

// Frees a texture now (the GPU no longer uses it).
void destroyTexture(fdw_dx_context *context, fdw_dx_texture *texture);
// Wraps a resource of the context (a swapchain image) as a texture.
fdw_dx_texture *wrapTexture(fdw_dx_context *context,
                            ComPtr<ID3D12Resource> resource,
                            const char *format, D3D12_RESOURCE_STATES state);
// Frees the pipelines, groups and layouts of a context being destroyed.
void destroyPipelines(fdw_dx_context *context);
// Destroys the swapchains of a context being destroyed.
void destroySwapchains(fdw_dx_context *context);

// Registers a read back copy submitted in `submission`: a ticket.
uint64_t addRead(fdw_dx_context *context, PendingRead read);

} // namespace fdw
