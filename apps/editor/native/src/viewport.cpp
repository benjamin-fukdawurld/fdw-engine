// The native viewport of the editor (P18 prototype, Linux X11): a child X11
// window placed in the Electron window over the area React reserves, and a
// Vulkan swapchain drawing a triangle into it. Everything native runs on a
// render thread of its own, with its own X connection: the main process of
// Electron only hands it the bounds.
//
// Node-API:
//   createViewport(parent: Buffer) -> handle   (getNativeWindowHandle())
//   setViewportBounds(handle, x, y, width, height)   (device pixels)
//   destroyViewport(handle)

#include <volk.h>
#include <X11/Xlib.h>
#include <X11/extensions/shape.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

const uint32_t kVertexSpirv[] = {
#include "triangle.vert.inc"
};
const uint32_t kFragmentSpirv[] = {
#include "triangle.frag.inc"
};

constexpr uint32_t kFramesInFlight = 2;

struct Bounds {
  int x = 0, y = 0, width = 0, height = 0;
};

// Shared by the main thread and the render thread.
struct Viewport {
  Window parent = 0;
  std::thread thread;
  std::atomic<bool> running{true};
  std::mutex mutex;
  Bounds bounds;  // Guarded by mutex.
  bool boundsChanged = false;
};

void check(VkResult result, const char *what) {
  if (result != VK_SUCCESS) {
    throw std::runtime_error(std::string(what) + " failed (VkResult " +
                             std::to_string(result) + ")");
  }
}

class Renderer {
 public:
  explicit Renderer(Viewport &viewport) : viewport_(viewport) {}
  ~Renderer() { destroy(); }

  void run() {
    init();
    const auto start = std::chrono::steady_clock::now();
    bool visible = false;
    while (viewport_.running.load()) {
      if (takeBounds()) {
        visible = bounds_.width > 0 && bounds_.height > 0;
        if (visible) {
          XMoveResizeWindow(display_, window_, bounds_.x, bounds_.y,
                            bounds_.width, bounds_.height);
          XMapWindow(display_, window_);
        } else {
          XUnmapWindow(display_, window_);
        }
        XSync(display_, False);
        outdated_ = true;
      }
      keepOnTop();
      if (!visible) {
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
        continue;
      }
      if (outdated_ && !createSwapchain()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
        continue;
      }
      const float time = std::chrono::duration<float>(
                             std::chrono::steady_clock::now() - start)
                             .count();
      drawFrame(time);
    }
  }

 private:
  bool takeBounds() {
    std::lock_guard lock(viewport_.mutex);
    if (!viewport_.boundsChanged) return false;
    bounds_ = viewport_.bounds;
    viewport_.boundsChanged = false;
    return true;
  }

  // Chromium draws the page into child windows of its own, recreated when
  // the window is resized: they would cover the viewport. Their creation
  // and restacking are watched, and the viewport raised above them.
  void keepOnTop() {
    bool raise = false;
    while (XPending(display_)) {
      XEvent event;
      XNextEvent(display_, &event);
      if (event.type == MapNotify) {
        raise |= event.xmap.window != window_;
      } else if (event.type == ConfigureNotify) {
        raise |= event.xconfigure.window != window_;
      }
    }
    if (raise) {
      XRaiseWindow(display_, window_);
      XFlush(display_);
    }
  }

  void init() {
    display_ = XOpenDisplay(nullptr);
    if (!display_) throw std::runtime_error("XOpenDisplay failed");
    // The same visual and depth as Electron's window; no background, so
    // that the X server paints nothing between two frames.
    XSetWindowAttributes attributes{};
    attributes.background_pixmap = None;
    window_ = XCreateWindow(display_, viewport_.parent, 0, 0, 1, 1, 0,
                            CopyFromParent, InputOutput, CopyFromParent,
                            CWBackPixmap, &attributes);
    // An empty input region: the mouse and keyboard reach the page under
    // the viewport, where the editor reads them.
    XShapeCombineRectangles(display_, window_, ShapeInput, 0, 0, nullptr, 0,
                            ShapeSet, Unsorted);
    XSelectInput(display_, viewport_.parent, SubstructureNotifyMask);
    XSync(display_, False);

    check(volkInitialize(), "volkInitialize");
    const char *extensions[] = {VK_KHR_SURFACE_EXTENSION_NAME,
                                VK_KHR_XLIB_SURFACE_EXTENSION_NAME};
    VkApplicationInfo application{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    application.pApplicationName = "FDW Editor";
    application.apiVersion = VK_API_VERSION_1_3;
    VkInstanceCreateInfo instanceInfo{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    instanceInfo.pApplicationInfo = &application;
    instanceInfo.enabledExtensionCount = 2;
    instanceInfo.ppEnabledExtensionNames = extensions;
    check(vkCreateInstance(&instanceInfo, nullptr, &instance_),
          "vkCreateInstance");
    volkLoadInstanceOnly(instance_);

    VkXlibSurfaceCreateInfoKHR surfaceInfo{
        VK_STRUCTURE_TYPE_XLIB_SURFACE_CREATE_INFO_KHR};
    surfaceInfo.dpy = display_;
    surfaceInfo.window = window_;
    check(vkCreateXlibSurfaceKHR(instance_, &surfaceInfo, nullptr, &surface_),
          "vkCreateXlibSurfaceKHR");

    pickDevice();
    createDevice();
    createPipeline();
    createFrames();
  }

  // A Vulkan 1.3 GPU with a queue that draws and presents to the surface,
  // a discrete one first.
  void pickDevice() {
    uint32_t count = 0;
    vkEnumeratePhysicalDevices(instance_, &count, nullptr);
    std::vector<VkPhysicalDevice> devices(count);
    vkEnumeratePhysicalDevices(instance_, &count, devices.data());
    int bestScore = -1;
    for (VkPhysicalDevice device : devices) {
      VkPhysicalDeviceProperties properties;
      vkGetPhysicalDeviceProperties(device, &properties);
      if (properties.apiVersion < VK_API_VERSION_1_3) continue;
      uint32_t familyCount = 0;
      vkGetPhysicalDeviceQueueFamilyProperties(device, &familyCount, nullptr);
      std::vector<VkQueueFamilyProperties> families(familyCount);
      vkGetPhysicalDeviceQueueFamilyProperties(device, &familyCount,
                                               families.data());
      for (uint32_t i = 0; i < familyCount; ++i) {
        VkBool32 present = VK_FALSE;
        vkGetPhysicalDeviceSurfaceSupportKHR(device, i, surface_, &present);
        if (!(families[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) || !present) {
          continue;
        }
        const int score =
            properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU ? 2
            : properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU        ? 0
                                                                          : 1;
        if (score > bestScore) {
          bestScore = score;
          physicalDevice_ = device;
          queueFamily_ = i;
        }
        break;
      }
    }
    if (!physicalDevice_) {
      throw std::runtime_error("No Vulkan 1.3 GPU presents to the viewport");
    }
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(physicalDevice_, &properties);
    std::fprintf(stderr, "[viewport] %s\n", properties.deviceName);
  }

  void createDevice() {
    const float priority = 1.0f;
    VkDeviceQueueCreateInfo queueInfo{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queueInfo.queueFamilyIndex = queueFamily_;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;
    VkPhysicalDeviceVulkan13Features features13{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    features13.dynamicRendering = VK_TRUE;
    features13.synchronization2 = VK_TRUE;
    const char *extensions[] = {VK_KHR_SWAPCHAIN_EXTENSION_NAME};
    VkDeviceCreateInfo deviceInfo{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    deviceInfo.pNext = &features13;
    deviceInfo.queueCreateInfoCount = 1;
    deviceInfo.pQueueCreateInfos = &queueInfo;
    deviceInfo.enabledExtensionCount = 1;
    deviceInfo.ppEnabledExtensionNames = extensions;
    check(vkCreateDevice(physicalDevice_, &deviceInfo, nullptr, &device_),
          "vkCreateDevice");
    volkLoadDevice(device_);
    vkGetDeviceQueue(device_, queueFamily_, 0, &queue_);

    // The format is chosen once: the pipeline is built for it.
    uint32_t count = 0;
    vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice_, surface_, &count,
                                         nullptr);
    std::vector<VkSurfaceFormatKHR> formats(count);
    vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice_, surface_, &count,
                                         formats.data());
    if (formats.empty()) throw std::runtime_error("No surface format");
    format_ = formats[0];
    for (const VkSurfaceFormatKHR &format : formats) {
      if (format.format == VK_FORMAT_B8G8R8A8_SRGB &&
          format.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR) {
        format_ = format;
      }
    }
  }

  VkShaderModule createShader(const uint32_t *code, size_t size) {
    VkShaderModuleCreateInfo info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    info.codeSize = size;
    info.pCode = code;
    VkShaderModule module;
    check(vkCreateShaderModule(device_, &info, nullptr, &module),
          "vkCreateShaderModule");
    return module;
  }

  void createPipeline() {
    VkPushConstantRange push{VK_SHADER_STAGE_VERTEX_BIT, 0, 2 * sizeof(float)};
    VkPipelineLayoutCreateInfo layoutInfo{
        VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    layoutInfo.pushConstantRangeCount = 1;
    layoutInfo.pPushConstantRanges = &push;
    check(vkCreatePipelineLayout(device_, &layoutInfo, nullptr, &layout_),
          "vkCreatePipelineLayout");

    VkShaderModule vertex = createShader(kVertexSpirv, sizeof(kVertexSpirv));
    VkShaderModule fragment =
        createShader(kFragmentSpirv, sizeof(kFragmentSpirv));
    VkPipelineShaderStageCreateInfo stages[2] = {
        {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO},
        {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO}};
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vertex;
    stages[0].pName = "main";
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = fragment;
    stages[1].pName = "main";

    VkPipelineVertexInputStateCreateInfo vertexInput{
        VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
    VkPipelineInputAssemblyStateCreateInfo assembly{
        VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};
    assembly.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkPipelineViewportStateCreateInfo viewportState{
        VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};
    viewportState.viewportCount = 1;
    viewportState.scissorCount = 1;
    VkPipelineRasterizationStateCreateInfo rasterization{
        VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};
    rasterization.cullMode = VK_CULL_MODE_NONE;
    rasterization.lineWidth = 1.0f;
    VkPipelineMultisampleStateCreateInfo multisample{
        VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};
    multisample.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;
    VkPipelineColorBlendAttachmentState blendAttachment{};
    blendAttachment.colorWriteMask =
        VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
        VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    VkPipelineColorBlendStateCreateInfo blend{
        VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};
    blend.attachmentCount = 1;
    blend.pAttachments = &blendAttachment;
    const VkDynamicState dynamicStates[] = {VK_DYNAMIC_STATE_VIEWPORT,
                                            VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynamic{
        VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};
    dynamic.dynamicStateCount = 2;
    dynamic.pDynamicStates = dynamicStates;
    VkPipelineRenderingCreateInfo rendering{
        VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO};
    rendering.colorAttachmentCount = 1;
    rendering.pColorAttachmentFormats = &format_.format;

    VkGraphicsPipelineCreateInfo info{
        VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};
    info.pNext = &rendering;
    info.stageCount = 2;
    info.pStages = stages;
    info.pVertexInputState = &vertexInput;
    info.pInputAssemblyState = &assembly;
    info.pViewportState = &viewportState;
    info.pRasterizationState = &rasterization;
    info.pMultisampleState = &multisample;
    info.pColorBlendState = &blend;
    info.pDynamicState = &dynamic;
    info.layout = layout_;
    const VkResult result = vkCreateGraphicsPipelines(
        device_, VK_NULL_HANDLE, 1, &info, nullptr, &pipeline_);
    vkDestroyShaderModule(device_, vertex, nullptr);
    vkDestroyShaderModule(device_, fragment, nullptr);
    check(result, "vkCreateGraphicsPipelines");
  }

  void createFrames() {
    VkCommandPoolCreateInfo poolInfo{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    poolInfo.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    poolInfo.queueFamilyIndex = queueFamily_;
    check(vkCreateCommandPool(device_, &poolInfo, nullptr, &pool_),
          "vkCreateCommandPool");
    VkCommandBufferAllocateInfo allocateInfo{
        VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    allocateInfo.commandPool = pool_;
    allocateInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocateInfo.commandBufferCount = kFramesInFlight;
    check(vkAllocateCommandBuffers(device_, &allocateInfo, commands_),
          "vkAllocateCommandBuffers");
    VkSemaphoreCreateInfo semaphoreInfo{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    VkFenceCreateInfo fenceInfo{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    fenceInfo.flags = VK_FENCE_CREATE_SIGNALED_BIT;
    for (uint32_t i = 0; i < kFramesInFlight; ++i) {
      check(vkCreateSemaphore(device_, &semaphoreInfo, nullptr, &acquired_[i]),
            "vkCreateSemaphore");
      check(vkCreateFence(device_, &fenceInfo, nullptr, &inFlight_[i]),
            "vkCreateFence");
    }
  }

  // (Re)creates the swapchain at the size of the window. False when the
  // window has no area to present into yet.
  bool createSwapchain() {
    vkDeviceWaitIdle(device_);
    VkSurfaceCapabilitiesKHR caps;
    check(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physicalDevice_, surface_,
                                                    &caps),
          "vkGetPhysicalDeviceSurfaceCapabilitiesKHR");
    extent_ = caps.currentExtent;
    if (extent_.width == UINT32_MAX) {
      extent_.width = std::clamp(uint32_t(bounds_.width), caps.minImageExtent.width,
                                 caps.maxImageExtent.width);
      extent_.height = std::clamp(uint32_t(bounds_.height), caps.minImageExtent.height,
                                  caps.maxImageExtent.height);
    }
    if (extent_.width == 0 || extent_.height == 0) return false;

    uint32_t imageCount = caps.minImageCount + 1;
    if (caps.maxImageCount > 0) imageCount = std::min(imageCount, caps.maxImageCount);
    VkCompositeAlphaFlagBitsKHR alpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    if (!(caps.supportedCompositeAlpha & alpha)) {
      alpha = VkCompositeAlphaFlagBitsKHR(caps.supportedCompositeAlpha &
                                          -caps.supportedCompositeAlpha);
    }
    VkSwapchainKHR old = swapchain_;
    VkSwapchainCreateInfoKHR info{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
    info.surface = surface_;
    info.minImageCount = imageCount;
    info.imageFormat = format_.format;
    info.imageColorSpace = format_.colorSpace;
    info.imageExtent = extent_;
    info.imageArrayLayers = 1;
    info.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    info.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    info.preTransform = caps.currentTransform;
    info.compositeAlpha = alpha;
    info.presentMode = VK_PRESENT_MODE_FIFO_KHR;
    info.clipped = VK_TRUE;
    info.oldSwapchain = old;
    check(vkCreateSwapchainKHR(device_, &info, nullptr, &swapchain_),
          "vkCreateSwapchainKHR");
    destroySwapchainImages();
    if (old) vkDestroySwapchainKHR(device_, old, nullptr);

    uint32_t count = 0;
    vkGetSwapchainImagesKHR(device_, swapchain_, &count, nullptr);
    images_.resize(count);
    vkGetSwapchainImagesKHR(device_, swapchain_, &count, images_.data());
    views_.resize(count);
    presented_.resize(count);
    VkSemaphoreCreateInfo semaphoreInfo{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    for (uint32_t i = 0; i < count; ++i) {
      VkImageViewCreateInfo viewInfo{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
      viewInfo.image = images_[i];
      viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
      viewInfo.format = format_.format;
      viewInfo.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
      check(vkCreateImageView(device_, &viewInfo, nullptr, &views_[i]),
            "vkCreateImageView");
      // One per image: a present may still wait on it when its frame slot
      // comes back.
      check(vkCreateSemaphore(device_, &semaphoreInfo, nullptr, &presented_[i]),
            "vkCreateSemaphore");
    }
    outdated_ = false;
    return true;
  }

  void destroySwapchainImages() {
    for (VkImageView view : views_) vkDestroyImageView(device_, view, nullptr);
    for (VkSemaphore semaphore : presented_) {
      vkDestroySemaphore(device_, semaphore, nullptr);
    }
    views_.clear();
    presented_.clear();
    images_.clear();
  }

  void barrier(VkCommandBuffer command, VkImage image, VkImageLayout from,
               VkImageLayout to, VkPipelineStageFlags2 srcStage,
               VkAccessFlags2 srcAccess, VkPipelineStageFlags2 dstStage,
               VkAccessFlags2 dstAccess) {
    VkImageMemoryBarrier2 imageBarrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2};
    imageBarrier.srcStageMask = srcStage;
    imageBarrier.srcAccessMask = srcAccess;
    imageBarrier.dstStageMask = dstStage;
    imageBarrier.dstAccessMask = dstAccess;
    imageBarrier.oldLayout = from;
    imageBarrier.newLayout = to;
    imageBarrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    imageBarrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    imageBarrier.image = image;
    imageBarrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    VkDependencyInfo dependency{VK_STRUCTURE_TYPE_DEPENDENCY_INFO};
    dependency.imageMemoryBarrierCount = 1;
    dependency.pImageMemoryBarriers = &imageBarrier;
    vkCmdPipelineBarrier2(command, &dependency);
  }

  void drawFrame(float time) {
    VkFence fence = inFlight_[frame_];
    check(vkWaitForFences(device_, 1, &fence, VK_TRUE, UINT64_MAX),
          "vkWaitForFences");
    uint32_t index = 0;
    // A timeout, so that destroyViewport is never stuck behind an acquire.
    VkResult result = vkAcquireNextImageKHR(device_, swapchain_, 100'000'000,
                                            acquired_[frame_], VK_NULL_HANDLE,
                                            &index);
    if (result == VK_TIMEOUT || result == VK_NOT_READY) return;
    if (result == VK_ERROR_OUT_OF_DATE_KHR) {
      outdated_ = true;
      return;
    }
    if (result != VK_SUBOPTIMAL_KHR) check(result, "vkAcquireNextImageKHR");
    vkResetFences(device_, 1, &fence);

    VkCommandBuffer command = commands_[frame_];
    vkResetCommandBuffer(command, 0);
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(command, &begin);
    barrier(command, images_[index], VK_IMAGE_LAYOUT_UNDEFINED,
            VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
            VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT, 0,
            VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
            VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT);
    VkRenderingAttachmentInfo attachment{
        VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO};
    attachment.imageView = views_[index];
    attachment.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    attachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    attachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    attachment.clearValue.color = {{0.02f, 0.03f, 0.06f, 1.0f}};
    VkRenderingInfo rendering{VK_STRUCTURE_TYPE_RENDERING_INFO};
    rendering.renderArea = {{0, 0}, extent_};
    rendering.layerCount = 1;
    rendering.colorAttachmentCount = 1;
    rendering.pColorAttachments = &attachment;
    vkCmdBeginRendering(command, &rendering);
    VkViewport viewport{0.0f, 0.0f, float(extent_.width), float(extent_.height),
                        0.0f, 1.0f};
    VkRect2D scissor{{0, 0}, extent_};
    vkCmdSetViewport(command, 0, 1, &viewport);
    vkCmdSetScissor(command, 0, 1, &scissor);
    vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_);
    const float push[2] = {time, float(extent_.width) / float(extent_.height)};
    vkCmdPushConstants(command, layout_, VK_SHADER_STAGE_VERTEX_BIT, 0,
                       sizeof(push), push);
    vkCmdDraw(command, 3, 1, 0, 0);
    vkCmdEndRendering(command);
    barrier(command, images_[index], VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
            VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
            VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
            VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT,
            VK_PIPELINE_STAGE_2_NONE, 0);
    vkEndCommandBuffer(command);

    const VkPipelineStageFlags waitStage =
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.waitSemaphoreCount = 1;
    submit.pWaitSemaphores = &acquired_[frame_];
    submit.pWaitDstStageMask = &waitStage;
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &command;
    submit.signalSemaphoreCount = 1;
    submit.pSignalSemaphores = &presented_[index];
    check(vkQueueSubmit(queue_, 1, &submit, fence), "vkQueueSubmit");

    VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
    present.waitSemaphoreCount = 1;
    present.pWaitSemaphores = &presented_[index];
    present.swapchainCount = 1;
    present.pSwapchains = &swapchain_;
    present.pImageIndices = &index;
    result = vkQueuePresentKHR(queue_, &present);
    if (result == VK_ERROR_OUT_OF_DATE_KHR || result == VK_SUBOPTIMAL_KHR) {
      outdated_ = true;
    } else {
      check(result, "vkQueuePresentKHR");
    }
    frame_ = (frame_ + 1) % kFramesInFlight;
  }

  void destroy() {
    if (device_) {
      vkDeviceWaitIdle(device_);
      destroySwapchainImages();
      if (swapchain_) vkDestroySwapchainKHR(device_, swapchain_, nullptr);
      for (uint32_t i = 0; i < kFramesInFlight; ++i) {
        if (acquired_[i]) vkDestroySemaphore(device_, acquired_[i], nullptr);
        if (inFlight_[i]) vkDestroyFence(device_, inFlight_[i], nullptr);
      }
      if (pool_) vkDestroyCommandPool(device_, pool_, nullptr);
      if (pipeline_) vkDestroyPipeline(device_, pipeline_, nullptr);
      if (layout_) vkDestroyPipelineLayout(device_, layout_, nullptr);
      vkDestroyDevice(device_, nullptr);
    }
    if (surface_) vkDestroySurfaceKHR(instance_, surface_, nullptr);
    if (instance_) vkDestroyInstance(instance_, nullptr);
    if (display_) {
      if (window_) XDestroyWindow(display_, window_);
      XCloseDisplay(display_);
    }
  }

  Viewport &viewport_;
  Bounds bounds_;
  bool outdated_ = true;

  Display *display_ = nullptr;
  Window window_ = 0;
  VkInstance instance_ = VK_NULL_HANDLE;
  VkSurfaceKHR surface_ = VK_NULL_HANDLE;
  VkPhysicalDevice physicalDevice_ = VK_NULL_HANDLE;
  uint32_t queueFamily_ = 0;
  VkDevice device_ = VK_NULL_HANDLE;
  VkQueue queue_ = VK_NULL_HANDLE;
  VkSurfaceFormatKHR format_{};
  VkPipelineLayout layout_ = VK_NULL_HANDLE;
  VkPipeline pipeline_ = VK_NULL_HANDLE;
  VkCommandPool pool_ = VK_NULL_HANDLE;
  VkCommandBuffer commands_[kFramesInFlight] = {};
  VkSemaphore acquired_[kFramesInFlight] = {};
  VkFence inFlight_[kFramesInFlight] = {};
  uint32_t frame_ = 0;

  VkSwapchainKHR swapchain_ = VK_NULL_HANDLE;
  VkExtent2D extent_{};
  std::vector<VkImage> images_;
  std::vector<VkImageView> views_;
  std::vector<VkSemaphore> presented_;
};

void renderThread(Viewport *viewport) {
  try {
    Renderer renderer(*viewport);
    renderer.run();
  } catch (const std::exception &error) {
    std::fprintf(stderr, "[viewport] %s\n", error.what());
  }
}

void stop(Viewport *viewport) {
  viewport->running.store(false);
  if (viewport->thread.joinable()) viewport->thread.join();
  delete viewport;
}

// The JS handle: an external to a slot, emptied by destroyViewport.
struct Handle {
  Viewport *viewport = nullptr;
};

void finalizeHandle(napi_env, void *data, void *) {
  auto *handle = static_cast<Handle *>(data);
  if (handle->viewport) stop(handle->viewport);
  delete handle;
}

napi_value throwError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

Handle *getHandle(napi_env env, napi_value value) {
  void *data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok) return nullptr;
  return static_cast<Handle *>(data);
}

napi_value createViewport(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *data = nullptr;
  size_t length = 0;
  if (argc < 1 ||
      napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok ||
      (length != sizeof(uint32_t) && length != sizeof(uint64_t))) {
    return throwError(env, "createViewport: expected the native window handle");
  }
  auto *viewport = new Viewport();
  // Electron gives the XID on 32 bits (x11::Window), Xlib on a long.
  if (length == sizeof(uint32_t)) {
    uint32_t xid;
    std::memcpy(&xid, data, sizeof(xid));
    viewport->parent = xid;
  } else {
    uint64_t xid;
    std::memcpy(&xid, data, sizeof(xid));
    viewport->parent = Window(xid);
  }
  viewport->thread = std::thread(renderThread, viewport);
  auto *handle = new Handle{viewport};
  napi_value result;
  napi_create_external(env, handle, finalizeHandle, nullptr, &result);
  return result;
}

napi_value setViewportBounds(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  Handle *handle = argc == 5 ? getHandle(env, argv[0]) : nullptr;
  if (!handle) return throwError(env, "setViewportBounds: expected a viewport");
  if (!handle->viewport) return nullptr;
  int32_t values[4];
  for (int i = 0; i < 4; ++i) {
    if (napi_get_value_int32(env, argv[i + 1], &values[i]) != napi_ok) {
      return throwError(env, "setViewportBounds: expected numbers");
    }
  }
  Viewport *viewport = handle->viewport;
  std::lock_guard lock(viewport->mutex);
  viewport->bounds = {values[0], values[1], std::max(values[2], 0),
                      std::max(values[3], 0)};
  viewport->boundsChanged = true;
  return nullptr;
}

napi_value destroyViewport(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  Handle *handle = argc == 1 ? getHandle(env, argv[0]) : nullptr;
  if (!handle) return throwError(env, "destroyViewport: expected a viewport");
  if (handle->viewport) {
    stop(handle->viewport);
    handle->viewport = nullptr;
  }
  return nullptr;
}

napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"createViewport", nullptr, createViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setViewportBounds", nullptr, setViewportBounds, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"destroyViewport", nullptr, destroyViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
