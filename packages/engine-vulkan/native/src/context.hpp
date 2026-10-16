// Internal state of the Vulkan library (include/fdw/vulkan.h).

#pragma once

#ifndef VK_NO_PROTOTYPES
#define VK_NO_PROTOTYPES
#endif
#include <volk.h>

// VMA calls the functions loaded by volk.
#define VMA_STATIC_VULKAN_FUNCTIONS 0
#define VMA_DYNAMIC_VULKAN_FUNCTIONS 1
#include <vk_mem_alloc.h>

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "fdw/vulkan.h"

namespace fdw {

// The last error of the thread, read by fdw_vk_last_error.
int fail(const std::string &message);
// A failed Vulkan call: its name and result.
int fail(const char *call, VkResult result);

// Something to do once the GPU has finished a submission: free a staging
// buffer, recycle a command buffer, destroy a resource.
struct Deferred {
  uint64_t submission;
  std::function<void()> run;
};

// A buffer read back: copied into `readback` by `submission`.
struct PendingRead {
  uint64_t submission;
  VkBuffer readback;
  VmaAllocation allocation;
  uint64_t size;
};

} // namespace fdw

namespace fdw {

// How a resource was last used, in the order of the queue: what the next
// use must wait for (option A of design/native-backends.md, §8.1).
struct Access {
  VkPipelineStageFlags2 stages = VK_PIPELINE_STAGE_2_NONE;
  VkAccessFlags2 access = VK_ACCESS_2_NONE;
};

// Whether an access writes.
bool writes(VkAccessFlags2 access);

} // namespace fdw

struct fdw_vk_buffer {
  uint32_t id = 0;
  VkBuffer buffer = VK_NULL_HANDLE;
  VmaAllocation allocation = nullptr;
  uint64_t size = 0;
  fdw::Access last;
};

struct fdw_vk_texture {
  uint32_t id = 0;
  VkImage image = VK_NULL_HANDLE;
  VmaAllocation allocation = nullptr;
  // The view of every layer, as the shaders see it.
  VkImageView view = VK_NULL_HANDLE;
  // A 2d view of the first layer, for the attachments.
  VkImageView attachmentView = VK_NULL_HANDLE;
  VkFormat format = VK_FORMAT_UNDEFINED;
  VkImageAspectFlags aspect = VK_IMAGE_ASPECT_COLOR_BIT;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t layers = 1;
  // Levels of detail.
  uint32_t levels = 1;
  // Bytes per pixel, or per block of block × block pixels for the
  // compressed formats.
  uint32_t pixelSize = 4;
  uint32_t block = 1;
  VkSampleCountFlagBits samples = VK_SAMPLE_COUNT_1_BIT;
  bool is3d = false;
  // An image of a swapchain: owned by it, not destroyed as a texture.
  bool external = false;
  // The layout of every subresource, and their last use.
  VkImageLayout layout = VK_IMAGE_LAYOUT_UNDEFINED;
  fdw::Access last;
};

struct fdw_vk_sampler {
  uint32_t id = 0;
  VkSampler sampler = VK_NULL_HANDLE;
};

struct fdw_vk_shader {
  VkShaderModule module = VK_NULL_HANDLE;
  VkShaderStageFlagBits stage = VK_SHADER_STAGE_VERTEX_BIT;
  std::string entryPoint;
};

struct fdw_vk_group_layout {
  uint32_t id = 0;
  VkDescriptorSetLayout layout = VK_NULL_HANDLE;
  std::vector<fdw_vk_layout_binding> bindings;
};

struct fdw_vk_group {
  uint32_t id = 0;
  VkDescriptorSet set = VK_NULL_HANDLE;
  VkDescriptorPool pool = VK_NULL_HANDLE;
  // The resources, by id, with how the shaders use them: their barriers
  // are placed before the passes that use the group.
  std::vector<std::pair<fdw_vk_binding_kind, uint32_t>> resources;
};

struct fdw_vk_pipeline {
  uint32_t id = 0;
  VkPipeline pipeline = VK_NULL_HANDLE;
  VkPipelineLayout layout = VK_NULL_HANDLE;
  VkPipelineBindPoint bindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
};

struct fdw_vk_query_pool {
  uint32_t id = 0;
  VkQueryPool pool = VK_NULL_HANDLE;
  uint32_t count = 0;
};

struct fdw_vk_context {
  VkInstance instance = VK_NULL_HANDLE;
  VkDebugUtilsMessengerEXT messenger = VK_NULL_HANDLE;
  bool debugUtils = false;
  bool validation = false;
  VkPhysicalDevice physicalDevice = VK_NULL_HANDLE;
  std::string deviceName;
  VkDevice device = VK_NULL_HANDLE;
  uint32_t queueFamily = 0;
  // The highest anisotropy of the samplers: 1 without the samplerAnisotropy
  // feature.
  float maxAnisotropy = 1;
  // The color attachments of a render pass (at most 8), and whether their
  // blend states can differ.
  uint32_t maxColorAttachments = 4;
  bool independentBlend = false;
  // The bits of the timestamps of the queue (0: none), and nanoseconds per
  // tick.
  uint32_t timestampValidBits = 0;
  float timestampPeriod = 0;
  VkQueue queue = VK_NULL_HANDLE;
  VmaAllocator allocator = nullptr;
  VkCommandPool commandPool = VK_NULL_HANDLE;

  // Every submission signals the next value of the timeline semaphore: a
  // submission is complete when the semaphore reaches its value.
  VkSemaphore timeline = VK_NULL_HANDLE;
  uint64_t submitted = 0;

  // The transfer commands recorded since the last submission: buffer
  // writes and read back copies, in order. Begun on first use. Their
  // barriers are those of the tracking, as for the replayed commands.
  VkCommandBuffer transfers = VK_NULL_HANDLE;
  bool transfersPending = false;

  std::vector<fdw::Deferred> deferred;
  std::map<uint64_t, fdw::PendingRead> reads;
  uint64_t nextTicket = 1;

  // The objects alive, by id; destroyed with the context.
  uint32_t nextId = 1;
  std::map<uint32_t, fdw_vk_buffer *> buffers;
  std::map<uint32_t, fdw_vk_texture *> textures;
  std::map<uint32_t, fdw_vk_sampler *> samplers;
  std::map<uint32_t, fdw_vk_group_layout *> groupLayouts;
  std::map<uint32_t, fdw_vk_group *> groups;
  std::map<uint32_t, fdw_vk_pipeline *> pipelines;
  std::map<uint32_t, fdw_vk_query_pool *> queryPools;
  std::set<fdw_vk_shader *> shaders;
  // The descriptor pools: a new one when the last is full.
  std::vector<VkDescriptorPool> descriptorPools;
  // The layout of the empty groups of the pipeline layouts.
  VkDescriptorSetLayout emptyGroupLayout = VK_NULL_HANDLE;

  std::vector<std::string> messages;

  // Presentation: the swapchains alive, and the semaphores the next
  // submission waits for (the acquired images).
  bool presentation = false;
  std::set<fdw_vk_swapchain *> swapchains;
  std::vector<VkSemaphoreSubmitInfo> pendingWaits;
};

namespace fdw {

// The command buffer of the transfers, begun if needed.
VkCommandBuffer transfers(fdw_vk_context *context);
// A memory barrier in a command buffer: everything before (stages and
// accesses `src`) happens before everything after (`dst`).
void memoryBarrier(VkCommandBuffer commands, VkPipelineStageFlags2 srcStages,
                   VkAccessFlags2 srcAccess, VkPipelineStageFlags2 dstStages,
                   VkAccessFlags2 dstAccess);
// Submits the transfers recorded, then the given command buffers, in one
// submission. Returns its timeline value, or 0 on error.
uint64_t submit(fdw_vk_context *context,
                const std::vector<VkCommandBuffer> &commands,
                VkSemaphore signal = VK_NULL_HANDLE);
// Destroys the swapchains of a context being destroyed.
void destroySwapchains(fdw_vk_context *context);
// The last submission the GPU has completed.
uint64_t completed(fdw_vk_context *context);
// Runs the deferred work of the completed submissions.
void collect(fdw_vk_context *context);
// Runs `run` once the GPU no longer uses what was submitted so far (and
// what is recorded but not yet submitted).
void defer(fdw_vk_context *context, std::function<void()> run);
// Gives a debug name to an object, with the validation layer.
void setName(fdw_vk_context *context, VkObjectType type, uint64_t handle,
             const char *name);

// A texture format of the engine. The compressed formats store blocks of
// block × block pixels, of pixelSize bytes.
struct FormatInfo {
  const char *name;
  VkFormat format;
  uint32_t pixelSize;
  VkImageAspectFlags aspect;
  uint32_t block = 1;
};
const FormatInfo *findFormat(const char *name);

// Frees the pipelines, groups and layouts of a context being destroyed.
void destroyPipelines(fdw_vk_context *context);

// A temporary buffer the CPU writes (staging) or reads (readback).
struct HostBuffer {
  VkBuffer buffer = VK_NULL_HANDLE;
  VmaAllocation allocation = nullptr;
  void *mapped = nullptr;
};
int createHostBuffer(fdw_vk_context *context, uint64_t size, bool readback,
                     HostBuffer *result);

// The barriers needed before a pass (render, compute, copy) or a transfer,
// gathered by useTexture and useBuffer, then placed together: one
// vkCmdPipelineBarrier2, at place() or at the end of the scope (an error
// return included: the tracked state already counts them).
struct Barriers {
  explicit Barriers(VkCommandBuffer commands) : commands(commands) {}
  Barriers(const Barriers &) = delete;
  Barriers &operator=(const Barriers &) = delete;
  ~Barriers() { place(); }
  void place();

  VkCommandBuffer commands;
  // At most one barrier per resource: the uses of a pass wait together for
  // the previous ones. `discards`: the old content of the image can be lost.
  std::vector<VkImageMemoryBarrier2> images;
  std::vector<fdw_vk_texture *> textures;
  std::vector<bool> discards;
  std::vector<VkBufferMemoryBarrier2> bufferBarriers;
  std::vector<fdw_vk_buffer *> buffers;
};

// Makes the next use of a texture wait for the previous one, changing its
// layout: an image barrier when needed, from the stages and accesses of the
// last use to those of this one. `discard`: the content can be lost (the
// use overwrites it all).
void useTexture(Barriers &barriers, fdw_vk_texture *texture,
                VkImageLayout layout, VkPipelineStageFlags2 stages,
                VkAccessFlags2 access, bool discard = false);
// The same for a buffer: a buffer barrier when needed.
void useBuffer(Barriers &barriers, fdw_vk_buffer *buffer,
               VkPipelineStageFlags2 stages, VkAccessFlags2 access);
// A single use, its barrier placed at once.
void useTexture(VkCommandBuffer commands, fdw_vk_texture *texture,
                VkImageLayout layout, VkPipelineStageFlags2 stages,
                VkAccessFlags2 access, bool discard = false);
void useBuffer(VkCommandBuffer commands, fdw_vk_buffer *buffer,
               VkPipelineStageFlags2 stages, VkAccessFlags2 access);

// Records the computation of the levels of a texture after the first one,
// each blitted from the previous one, in every layer.
int generateMipmaps(fdw_vk_context *context, VkCommandBuffer commands,
                    fdw_vk_texture *texture);

// Frees a texture now (the GPU no longer uses it).
void destroyTexture(fdw_vk_context *context, fdw_vk_texture *texture);

// Registers a read back copy submitted in `submission`: a ticket.
uint64_t addRead(fdw_vk_context *context, uint64_t submission,
                 const HostBuffer &readback, uint64_t size);

} // namespace fdw
