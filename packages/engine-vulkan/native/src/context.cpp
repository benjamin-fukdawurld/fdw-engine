// The context: instance, device, validation messages, submissions.

#include "context.hpp"

#include <vulkan/vk_enum_string_helper.h>

#include <algorithm>
#include <cstring>

namespace fdw {

namespace {
thread_local std::string lastError;
} // namespace

int fail(const std::string &message) {
  lastError = message;
  return -1;
}

int fail(const char *call, VkResult result) {
  return fail(std::string(call) + " failed: " + string_VkResult(result));
}

VkCommandBuffer transfers(fdw_vk_context *context) {
  if (context->transfersPending) {
    return context->transfers;
  }
  if (context->transfers == VK_NULL_HANDLE) {
    VkCommandBufferAllocateInfo allocate{
        VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    allocate.commandPool = context->commandPool;
    allocate.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocate.commandBufferCount = 1;
    vkAllocateCommandBuffers(context->device, &allocate, &context->transfers);
  }
  VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  vkBeginCommandBuffer(context->transfers, &begin);
  // After everything submitted before: the transfers can overwrite what
  // earlier commands read or wrote.
  memoryBarrier(context->transfers, VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT,
                VK_ACCESS_2_MEMORY_READ_BIT | VK_ACCESS_2_MEMORY_WRITE_BIT,
                VK_PIPELINE_STAGE_2_ALL_TRANSFER_BIT,
                VK_ACCESS_2_TRANSFER_READ_BIT | VK_ACCESS_2_TRANSFER_WRITE_BIT);
  context->transfersPending = true;
  return context->transfers;
}

void memoryBarrier(VkCommandBuffer commands, VkPipelineStageFlags2 srcStages,
                   VkAccessFlags2 srcAccess, VkPipelineStageFlags2 dstStages,
                   VkAccessFlags2 dstAccess) {
  VkMemoryBarrier2 barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER_2};
  barrier.srcStageMask = srcStages;
  barrier.srcAccessMask = srcAccess;
  barrier.dstStageMask = dstStages;
  barrier.dstAccessMask = dstAccess;
  VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
  dependency.memoryBarrierCount = 1;
  dependency.pMemoryBarriers = &barrier;
  vkCmdPipelineBarrier2(commands, &dependency);
}

uint64_t submit(fdw_vk_context *context,
                const std::vector<VkCommandBuffer> &commands,
                VkSemaphore signalBinary) {
  std::vector<VkCommandBufferSubmitInfo> buffers;
  if (context->transfersPending) {
    // The commands after the transfers see what they wrote.
    memoryBarrier(context->transfers, VK_PIPELINE_STAGE_2_ALL_TRANSFER_BIT,
                  VK_ACCESS_2_TRANSFER_WRITE_BIT,
                  VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT,
                  VK_ACCESS_2_MEMORY_READ_BIT | VK_ACCESS_2_MEMORY_WRITE_BIT);
    vkEndCommandBuffer(context->transfers);
    buffers.push_back(
        {VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO, nullptr,
         context->transfers, 0});
    context->transfersPending = false;
  }
  for (VkCommandBuffer command : commands) {
    buffers.push_back(
        {VK_STRUCTURE_TYPE_COMMAND_BUFFER_SUBMIT_INFO, nullptr, command, 0});
  }
  const uint64_t value = context->submitted + 1;
  std::vector<VkSemaphoreSubmitInfo> signals(1);
  signals[0] = {VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO};
  signals[0].semaphore = context->timeline;
  signals[0].value = value;
  signals[0].stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
  if (signalBinary) {
    VkSemaphoreSubmitInfo binary{VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO};
    binary.semaphore = signalBinary;
    binary.stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
    signals.push_back(binary);
  }
  // The images acquired since the last submission are ready.
  const std::vector<VkSemaphoreSubmitInfo> waits =
      std::move(context->pendingWaits);
  context->pendingWaits.clear();
  VkSubmitInfo2 info{VK_STRUCTURE_TYPE_SUBMIT_INFO_2};
  info.waitSemaphoreInfoCount = static_cast<uint32_t>(waits.size());
  info.pWaitSemaphoreInfos = waits.data();
  info.commandBufferInfoCount = static_cast<uint32_t>(buffers.size());
  info.pCommandBufferInfos = buffers.data();
  info.signalSemaphoreInfoCount = static_cast<uint32_t>(signals.size());
  info.pSignalSemaphoreInfos = signals.data();
  const VkResult result =
      vkQueueSubmit2(context->queue, 1, &info, VK_NULL_HANDLE);
  if (result != VK_SUCCESS) {
    fail("vkQueueSubmit2", result);
    return 0;
  }
  context->submitted = value;
  // The transfer command buffer is reused once this submission is done:
  // the next transfers wait for it.
  if (!buffers.empty() && buffers[0].commandBuffer == context->transfers) {
    VkCommandBuffer used = context->transfers;
    context->transfers = VK_NULL_HANDLE;
    context->deferred.push_back({value, [context, used] {
                                   vkFreeCommandBuffers(context->device,
                                                        context->commandPool,
                                                        1, &used);
                                 }});
  }
  return value;
}

uint64_t completed(fdw_vk_context *context) {
  uint64_t value = 0;
  vkGetSemaphoreCounterValue(context->device, context->timeline, &value);
  return value;
}

void collect(fdw_vk_context *context) {
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

void defer(fdw_vk_context *context, std::function<void()> run) {
  // The recorded transfers may use the object: after their submission.
  const uint64_t after =
      context->submitted + (context->transfersPending ? 1 : 0);
  context->deferred.push_back({after, std::move(run)});
}

void setName(fdw_vk_context *context, VkObjectType type, uint64_t handle,
             const char *name) {
  if (!context->debugUtils || !name || !*name) {
    return;
  }
  VkDebugUtilsObjectNameInfoEXT info{
      VK_STRUCTURE_TYPE_DEBUG_UTILS_OBJECT_NAME_INFO_EXT};
  info.objectType = type;
  info.objectHandle = handle;
  info.pObjectName = name;
  vkSetDebugUtilsObjectNameEXT(context->device, &info);
}

int createHostBuffer(fdw_vk_context *context, uint64_t size, bool readback,
                     HostBuffer *result) {
  VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
  info.size = size;
  info.usage = readback ? VK_BUFFER_USAGE_TRANSFER_DST_BIT
                        : VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
  VmaAllocationCreateInfo allocation{};
  allocation.usage = VMA_MEMORY_USAGE_AUTO;
  allocation.flags =
      VMA_ALLOCATION_CREATE_MAPPED_BIT |
      (readback ? VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT
                : VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT);
  VmaAllocationInfo allocated{};
  const VkResult status =
      vmaCreateBuffer(context->allocator, &info, &allocation, &result->buffer,
                      &result->allocation, &allocated);
  if (status != VK_SUCCESS) {
    return fail("vmaCreateBuffer", status);
  }
  result->mapped = allocated.pMappedData;
  return 0;
}

namespace {

VKAPI_ATTR VkBool32 VKAPI_CALL
onMessage(VkDebugUtilsMessageSeverityFlagBitsEXT severity,
          VkDebugUtilsMessageTypeFlagsEXT, const
          VkDebugUtilsMessengerCallbackDataEXT *data,
          void *user) {
  auto *context = static_cast<fdw_vk_context *>(user);
  const char *level =
      severity >= VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT ? "error"
                                                                : "warning";
  context->messages.push_back(std::string(level) + ": " +
                              (data->pMessage ? data->pMessage : ""));
  return VK_FALSE;
}

bool hasLayer(const char *name) {
  uint32_t count = 0;
  vkEnumerateInstanceLayerProperties(&count, nullptr);
  std::vector<VkLayerProperties> layers(count);
  vkEnumerateInstanceLayerProperties(&count, layers.data());
  return std::any_of(layers.begin(), layers.end(), [name](const auto &layer) {
    return std::strcmp(layer.layerName, name) == 0;
  });
}

bool hasInstanceExtension(const char *name) {
  uint32_t count = 0;
  vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr);
  std::vector<VkExtensionProperties> extensions(count);
  vkEnumerateInstanceExtensionProperties(nullptr, &count, extensions.data());
  return std::any_of(extensions.begin(), extensions.end(),
                     [name](const auto &extension) {
                       return std::strcmp(extension.extensionName, name) == 0;
                     });
}

bool hasDeviceExtension(VkPhysicalDevice device, const char *name) {
  uint32_t count = 0;
  vkEnumerateDeviceExtensionProperties(device, nullptr, &count, nullptr);
  std::vector<VkExtensionProperties> extensions(count);
  vkEnumerateDeviceExtensionProperties(device, nullptr, &count,
                                       extensions.data());
  return std::any_of(extensions.begin(), extensions.end(),
                     [name](const auto &extension) {
                       return std::strcmp(extension.extensionName, name) == 0;
                     });
}

int createInstance(fdw_vk_context *context,
                   const fdw_vk_context_options &options) {
  std::vector<const char *> layers;
  std::vector<const char *> extensions;
  VkInstanceCreateFlags flags = 0;
  if (options.validation && hasLayer("VK_LAYER_KHRONOS_validation") &&
      hasInstanceExtension(VK_EXT_DEBUG_UTILS_EXTENSION_NAME)) {
    layers.push_back("VK_LAYER_KHRONOS_validation");
    extensions.push_back(VK_EXT_DEBUG_UTILS_EXTENSION_NAME);
    context->validation = true;
    context->debugUtils = true;
  }
  // Presentation into windows, where the extensions are there.
  if (hasInstanceExtension(VK_KHR_SURFACE_EXTENSION_NAME)) {
    extensions.push_back(VK_KHR_SURFACE_EXTENSION_NAME);
    for (const char *platform : {"VK_KHR_xlib_surface", "VK_KHR_wayland_surface",
                                 "VK_KHR_win32_surface", "VK_EXT_metal_surface"}) {
      if (hasInstanceExtension(platform)) {
        extensions.push_back(platform);
      }
    }
  }
  // MoltenVK (macOS) is a portability implementation.
  if (hasInstanceExtension(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)) {
    extensions.push_back(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);
    flags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
  }

  VkApplicationInfo application{VK_STRUCTURE_TYPE_APPLICATION_INFO};
  application.pApplicationName =
      options.application ? options.application : "FdwEngine";
  application.pEngineName = "FdwEngine";
  application.apiVersion = VK_API_VERSION_1_3;
  VkInstanceCreateInfo info{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
  info.flags = flags;
  info.pApplicationInfo = &application;
  info.enabledLayerCount = static_cast<uint32_t>(layers.size());
  info.ppEnabledLayerNames = layers.data();
  info.enabledExtensionCount = static_cast<uint32_t>(extensions.size());
  info.ppEnabledExtensionNames = extensions.data();
  const VkResult result =
      vkCreateInstance(&info, nullptr, &context->instance);
  if (result != VK_SUCCESS) {
    return fail("vkCreateInstance", result);
  }
  volkLoadInstance(context->instance);

  if (context->debugUtils) {
    VkDebugUtilsMessengerCreateInfoEXT messenger{
        VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT};
    messenger.messageSeverity =
        VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
        VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
    messenger.messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
                            VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT;
    messenger.pfnUserCallback = onMessage;
    messenger.pUserData = context;
    vkCreateDebugUtilsMessengerEXT(context->instance, &messenger, nullptr,
                                   &context->messenger);
  }
  return 0;
}

// The first suitable discrete GPU, else the first suitable one.
int choosePhysicalDevice(fdw_vk_context *context) {
  uint32_t count = 0;
  vkEnumeratePhysicalDevices(context->instance, &count, nullptr);
  std::vector<VkPhysicalDevice> devices(count);
  vkEnumeratePhysicalDevices(context->instance, &count, devices.data());

  VkPhysicalDevice chosen = VK_NULL_HANDLE;
  for (VkPhysicalDevice device : devices) {
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(device, &properties);
    if (properties.apiVersion < VK_API_VERSION_1_3) {
      continue;
    }
    VkPhysicalDeviceVulkan13Features features13{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceVulkan12Features features12{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, &features13};
    VkPhysicalDeviceFeatures2 features{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, &features12};
    vkGetPhysicalDeviceFeatures2(device, &features);
    if (!features13.dynamicRendering || !features13.synchronization2 ||
        !features12.timelineSemaphore) {
      continue;
    }
    if (!chosen ||
        properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
      chosen = device;
      context->deviceName = properties.deviceName;
      if (properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
        break;
      }
    }
  }
  if (!chosen) {
    return fail("No GPU with Vulkan 1.3, dynamic rendering and "
                "synchronization2");
  }
  context->physicalDevice = chosen;

  uint32_t familyCount = 0;
  vkGetPhysicalDeviceQueueFamilyProperties(chosen, &familyCount, nullptr);
  std::vector<VkQueueFamilyProperties> families(familyCount);
  vkGetPhysicalDeviceQueueFamilyProperties(chosen, &familyCount,
                                           families.data());
  for (uint32_t i = 0; i < familyCount; i++) {
    const VkQueueFlags needed = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT;
    if ((families[i].queueFlags & needed) == needed) {
      context->queueFamily = i;
      context->timestampValidBits = families[i].timestampValidBits;
      VkPhysicalDeviceProperties properties;
      vkGetPhysicalDeviceProperties(chosen, &properties);
      context->timestampPeriod = properties.limits.timestampPeriod;
      return 0;
    }
  }
  return fail("No queue with graphics and compute");
}

int createDevice(fdw_vk_context *context) {
  VkPhysicalDeviceFeatures available;
  vkGetPhysicalDeviceFeatures(context->physicalDevice, &available);

  VkPhysicalDeviceVulkan13Features features13{
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
  features13.dynamicRendering = VK_TRUE;
  features13.synchronization2 = VK_TRUE;
  // DXC compiles discard to OpDemoteToHelperInvocation for Vulkan 1.3 (a
  // required feature of 1.3).
  features13.shaderDemoteToHelperInvocation = VK_TRUE;
  VkPhysicalDeviceVulkan12Features features12{
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, &features13};
  features12.timelineSemaphore = VK_TRUE;
  VkPhysicalDeviceFeatures2 features{
      VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, &features12};
  features.features.samplerAnisotropy = available.samplerAnisotropy;
  if (available.samplerAnisotropy) {
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(context->physicalDevice, &properties);
    context->maxAnisotropy = properties.limits.maxSamplerAnisotropy;
  }
  features.features.independentBlend = available.independentBlend;
  context->independentBlend = available.independentBlend;
  {
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(context->physicalDevice, &properties);
    context->maxColorAttachments =
        std::min(properties.limits.maxColorAttachments, 8u);
  }

  std::vector<const char *> extensions;
  if (hasDeviceExtension(context->physicalDevice,
                         VK_KHR_SWAPCHAIN_EXTENSION_NAME)) {
    extensions.push_back(VK_KHR_SWAPCHAIN_EXTENSION_NAME);
    context->presentation = true;
  }
  if (hasDeviceExtension(context->physicalDevice, "VK_KHR_portability_subset")) {
    extensions.push_back("VK_KHR_portability_subset");
  }

  const float priority = 1.0f;
  VkDeviceQueueCreateInfo queue{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
  queue.queueFamilyIndex = context->queueFamily;
  queue.queueCount = 1;
  queue.pQueuePriorities = &priority;
  VkDeviceCreateInfo info{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, &features};
  info.queueCreateInfoCount = 1;
  info.pQueueCreateInfos = &queue;
  info.enabledExtensionCount = static_cast<uint32_t>(extensions.size());
  info.ppEnabledExtensionNames = extensions.data();
  VkResult result =
      vkCreateDevice(context->physicalDevice, &info, nullptr, &context->device);
  if (result != VK_SUCCESS) {
    return fail("vkCreateDevice", result);
  }
  volkLoadDevice(context->device);
  vkGetDeviceQueue(context->device, context->queueFamily, 0, &context->queue);

  VmaVulkanFunctions functions{};
  functions.vkGetInstanceProcAddr = vkGetInstanceProcAddr;
  functions.vkGetDeviceProcAddr = vkGetDeviceProcAddr;
  VmaAllocatorCreateInfo allocator{};
  allocator.vulkanApiVersion = VK_API_VERSION_1_3;
  allocator.physicalDevice = context->physicalDevice;
  allocator.device = context->device;
  allocator.instance = context->instance;
  allocator.pVulkanFunctions = &functions;
  result = vmaCreateAllocator(&allocator, &context->allocator);
  if (result != VK_SUCCESS) {
    return fail("vmaCreateAllocator", result);
  }

  VkCommandPoolCreateInfo pool{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
  pool.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
  pool.queueFamilyIndex = context->queueFamily;
  result = vkCreateCommandPool(context->device, &pool, nullptr,
                               &context->commandPool);
  if (result != VK_SUCCESS) {
    return fail("vkCreateCommandPool", result);
  }

  VkSemaphoreTypeCreateInfo type{VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO};
  type.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
  type.initialValue = 0;
  VkSemaphoreCreateInfo semaphore{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO,
                                  &type};
  result = vkCreateSemaphore(context->device, &semaphore, nullptr,
                             &context->timeline);
  if (result != VK_SUCCESS) {
    return fail("vkCreateSemaphore", result);
  }
  return 0;
}

} // namespace
} // namespace fdw

using namespace fdw;

extern "C" {

const char *fdw_vk_last_error(void) { return lastError.c_str(); }

fdw_vk_context *fdw_vk_context_create(const fdw_vk_context_options *options) {
  static bool loaded = false;
  if (!loaded) {
    const VkResult result = volkInitialize();
    if (result != VK_SUCCESS) {
      fail("No Vulkan loader (volkInitialize)", result);
      return nullptr;
    }
    loaded = true;
  }
  const fdw_vk_context_options defaults{0, nullptr};
  auto *context = new fdw_vk_context();
  if (createInstance(context, options ? *options : defaults) != 0 ||
      choosePhysicalDevice(context) != 0 || createDevice(context) != 0) {
    const std::string error = lastError;
    fdw_vk_context_destroy(context);
    lastError = error;
    return nullptr;
  }
  return context;
}

void fdw_vk_context_destroy(fdw_vk_context *context) {
  if (!context) {
    return;
  }
  if (context->device) {
    vkDeviceWaitIdle(context->device);
    collect(context);
    // Everything still deferred can run: the GPU is idle.
    for (Deferred &entry : context->deferred) {
      entry.run();
    }
    context->deferred.clear();
    for (auto &[ticket, read] : context->reads) {
      vmaDestroyBuffer(context->allocator, read.readback, read.allocation);
    }
    context->reads.clear();
    destroySwapchains(context);
    destroyPipelines(context);
    for (auto &[id, buffer] : context->buffers) {
      vmaDestroyBuffer(context->allocator, buffer->buffer, buffer->allocation);
      delete buffer;
    }
    context->buffers.clear();
    for (auto &[id, texture] : context->textures) {
      destroyTexture(context, texture);
    }
    context->textures.clear();
    for (auto &[id, sampler] : context->samplers) {
      vkDestroySampler(context->device, sampler->sampler, nullptr);
      delete sampler;
    }
    context->samplers.clear();
    for (auto &[id, pool] : context->queryPools) {
      vkDestroyQueryPool(context->device, pool->pool, nullptr);
      delete pool;
    }
    context->queryPools.clear();
    if (context->timeline) {
      vkDestroySemaphore(context->device, context->timeline, nullptr);
    }
    if (context->commandPool) {
      vkDestroyCommandPool(context->device, context->commandPool, nullptr);
    }
    if (context->allocator) {
      vmaDestroyAllocator(context->allocator);
    }
    vkDestroyDevice(context->device, nullptr);
  }
  if (context->messenger) {
    vkDestroyDebugUtilsMessengerEXT(context->instance, context->messenger,
                                    nullptr);
  }
  if (context->instance) {
    vkDestroyInstance(context->instance, nullptr);
  }
  delete context;
}

const char *fdw_vk_device_name(const fdw_vk_context *context) {
  return context->deviceName.c_str();
}

int32_t fdw_vk_validation_enabled(const fdw_vk_context *context) {
  return context->validation ? 1 : 0;
}

int fdw_vk_wait_idle(fdw_vk_context *context) {
  if (context->transfersPending && submit(context, {}) == 0) {
    return -1;
  }
  const VkResult result = vkQueueWaitIdle(context->queue);
  if (result != VK_SUCCESS) {
    return fail("vkQueueWaitIdle", result);
  }
  collect(context);
  return 0;
}

int fdw_vk_flush(fdw_vk_context *context) {
  if (context->transfersPending && submit(context, {}) == 0) {
    return -1;
  }
  collect(context);
  return 0;
}

size_t fdw_vk_message_count(const fdw_vk_context *context) {
  return context->messages.size();
}

const char *fdw_vk_message(const fdw_vk_context *context, size_t index) {
  return index < context->messages.size() ? context->messages[index].c_str()
                                          : "";
}

void fdw_vk_clear_messages(fdw_vk_context *context) {
  context->messages.clear();
}

} // extern "C"
