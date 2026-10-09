// Swapchains: presentation into the windows of the system.

#include "context.hpp"

#include <algorithm>
#include <array>
#include <limits>

using namespace fdw;

struct fdw_vk_swapchain {
  VkSurfaceKHR surface = VK_NULL_HANDLE;
  VkSwapchainKHR swapchain = VK_NULL_HANDLE;
  VkFormat format = VK_FORMAT_UNDEFINED;
  const char *formatName = "bgra8unorm";
  VkPresentModeKHR presentMode = VK_PRESENT_MODE_FIFO_KHR;
  VkExtent2D extent{};
  std::vector<fdw_vk_texture *> images;
  // Signaled by the acquisitions, waited by the next submission: a ring,
  // reused once the frame waiting for it is done.
  std::vector<VkSemaphore> acquired;
  uint32_t nextAcquired = 0;
  // Signaled by the last submission before a present, waited by the
  // present: one per image.
  std::vector<VkSemaphore> rendered;
  // The image acquired, or -1.
  int32_t current = -1;
  // The submissions of the last frames presented: at most two in flight.
  std::array<uint64_t, 2> frames{};
  uint32_t frame = 0;
  bool outdated = false;
};

namespace {

int createSurface(fdw_vk_context *context, const fdw_vk_window_handle &window,
                  VkSurfaceKHR *surface) {
  VkResult result = VK_ERROR_EXTENSION_NOT_PRESENT;
  switch (window.system) {
#if defined(VK_USE_PLATFORM_XLIB_KHR)
  case 1: {
    if (!vkCreateXlibSurfaceKHR) {
      break;
    }
    VkXlibSurfaceCreateInfoKHR info{
        VK_STRUCTURE_TYPE_XLIB_SURFACE_CREATE_INFO_KHR};
    info.dpy = reinterpret_cast<Display *>(window.display);
    info.window = static_cast<Window>(window.window);
    result = vkCreateXlibSurfaceKHR(context->instance, &info, nullptr, surface);
    break;
  }
#endif
#if defined(VK_USE_PLATFORM_WAYLAND_KHR)
  case 2: {
    if (!vkCreateWaylandSurfaceKHR) {
      break;
    }
    VkWaylandSurfaceCreateInfoKHR info{
        VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR};
    info.display = reinterpret_cast<wl_display *>(window.display);
    info.surface = reinterpret_cast<wl_surface *>(window.window);
    result =
        vkCreateWaylandSurfaceKHR(context->instance, &info, nullptr, surface);
    break;
  }
#endif
#if defined(VK_USE_PLATFORM_WIN32_KHR)
  case 3: {
    VkWin32SurfaceCreateInfoKHR info{
        VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR};
    info.hinstance = reinterpret_cast<HINSTANCE>(window.display);
    info.hwnd = reinterpret_cast<HWND>(window.window);
    result = vkCreateWin32SurfaceKHR(context->instance, &info, nullptr, surface);
    break;
  }
#endif
  default:
    return fail("Presentation into this window system is not supported yet");
  }
  return result == VK_SUCCESS ? 0 : fail("Creating the window surface", result);
}

// The images of the current swapchain, as textures of the commands.
int wrapImages(fdw_vk_context *context, fdw_vk_swapchain *swapchain) {
  uint32_t count = 0;
  vkGetSwapchainImagesKHR(context->device, swapchain->swapchain, &count,
                          nullptr);
  std::vector<VkImage> images(count);
  vkGetSwapchainImagesKHR(context->device, swapchain->swapchain, &count,
                          images.data());
  for (VkImage image : images) {
    auto *texture = new fdw_vk_texture();
    texture->image = image;
    texture->external = true;
    texture->format = swapchain->format;
    texture->width = swapchain->extent.width;
    texture->height = swapchain->extent.height;
    VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};
    view.image = image;
    view.viewType = VK_IMAGE_VIEW_TYPE_2D;
    view.format = swapchain->format;
    view.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    const VkResult result =
        vkCreateImageView(context->device, &view, nullptr, &texture->view);
    if (result != VK_SUCCESS) {
      delete texture;
      return fail("vkCreateImageView", result);
    }
    texture->attachmentView = VK_NULL_HANDLE;
    texture->id = context->nextId++;
    context->textures[texture->id] = texture;
    swapchain->images.push_back(texture);
  }
  // Attachments and shaders see the same 2d view.
  for (fdw_vk_texture *texture : swapchain->images) {
    texture->attachmentView = texture->view;
    texture->view = VK_NULL_HANDLE;
  }
  while (swapchain->rendered.size() < count) {
    VkSemaphoreCreateInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    VkSemaphore semaphore;
    vkCreateSemaphore(context->device, &info, nullptr, &semaphore);
    swapchain->rendered.push_back(semaphore);
  }
  while (swapchain->acquired.size() < count + 1) {
    VkSemaphoreCreateInfo info{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    VkSemaphore semaphore;
    vkCreateSemaphore(context->device, &info, nullptr, &semaphore);
    swapchain->acquired.push_back(semaphore);
  }
  return 0;
}

void releaseImages(fdw_vk_context *context, fdw_vk_swapchain *swapchain) {
  for (fdw_vk_texture *texture : swapchain->images) {
    context->textures.erase(texture->id);
    destroyTexture(context, texture);
  }
  swapchain->images.clear();
}

// (Re)creates the swapchain at a size, the old one handed over.
int build(fdw_vk_context *context, fdw_vk_swapchain *swapchain, uint32_t width,
          uint32_t height) {
  VkSurfaceCapabilitiesKHR capabilities;
  vkGetPhysicalDeviceSurfaceCapabilitiesKHR(context->physicalDevice,
                                            swapchain->surface, &capabilities);
  VkExtent2D extent = capabilities.currentExtent;
  if (extent.width == std::numeric_limits<uint32_t>::max()) {
    extent = {std::clamp(width, capabilities.minImageExtent.width,
                         capabilities.maxImageExtent.width),
              std::clamp(height, capabilities.minImageExtent.height,
                         capabilities.maxImageExtent.height)};
  }
  if (extent.width == 0 || extent.height == 0) {
    // A minimized window: nothing to present into.
    return fail("The window has no area to present into");
  }
  uint32_t imageCount = capabilities.minImageCount + 1;
  if (capabilities.maxImageCount > 0) {
    imageCount = std::min(imageCount, capabilities.maxImageCount);
  }
  const VkImageUsageFlags wanted = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT |
                                   VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
                                   VK_IMAGE_USAGE_TRANSFER_DST_BIT;
  VkSwapchainCreateInfoKHR info{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};
  info.surface = swapchain->surface;
  info.minImageCount = imageCount;
  info.imageFormat = swapchain->format;
  info.imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
  info.imageExtent = extent;
  info.imageArrayLayers = 1;
  info.imageUsage = wanted & capabilities.supportedUsageFlags;
  info.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
  info.preTransform = capabilities.currentTransform;
  info.compositeAlpha =
      (capabilities.supportedCompositeAlpha &
       VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR)
          ? VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR
          : static_cast<VkCompositeAlphaFlagBitsKHR>(
                capabilities.supportedCompositeAlpha &
                -capabilities.supportedCompositeAlpha);
  info.presentMode = swapchain->presentMode;
  info.clipped = VK_TRUE;
  info.oldSwapchain = swapchain->swapchain;

  // Nothing may use the old images any more.
  vkDeviceWaitIdle(context->device);
  collect(context);
  releaseImages(context, swapchain);
  VkSwapchainKHR created = VK_NULL_HANDLE;
  const VkResult result =
      vkCreateSwapchainKHR(context->device, &info, nullptr, &created);
  if (swapchain->swapchain) {
    vkDestroySwapchainKHR(context->device, swapchain->swapchain, nullptr);
  }
  swapchain->swapchain = created;
  if (result != VK_SUCCESS) {
    return fail("vkCreateSwapchainKHR", result);
  }
  swapchain->extent = extent;
  swapchain->outdated = false;
  return wrapImages(context, swapchain);
}

void destroy(fdw_vk_context *context, fdw_vk_swapchain *swapchain) {
  vkDeviceWaitIdle(context->device);
  releaseImages(context, swapchain);
  for (VkSemaphore semaphore : swapchain->acquired) {
    vkDestroySemaphore(context->device, semaphore, nullptr);
  }
  for (VkSemaphore semaphore : swapchain->rendered) {
    vkDestroySemaphore(context->device, semaphore, nullptr);
  }
  if (swapchain->swapchain) {
    vkDestroySwapchainKHR(context->device, swapchain->swapchain, nullptr);
  }
  if (swapchain->surface) {
    vkDestroySurfaceKHR(context->instance, swapchain->surface, nullptr);
  }
  delete swapchain;
}

} // namespace

namespace fdw {

void destroySwapchains(fdw_vk_context *context) {
  for (fdw_vk_swapchain *swapchain : context->swapchains) {
    destroy(context, swapchain);
  }
  context->swapchains.clear();
}

} // namespace fdw

extern "C" {

fdw_vk_swapchain *fdw_vk_swapchain_create(fdw_vk_context *context,
                                          const fdw_vk_window_handle *window,
                                          uint32_t width, uint32_t height,
                                          int32_t vsync) {
  if (!context->presentation) {
    fail("The device cannot present (no VK_KHR_swapchain)");
    return nullptr;
  }
  auto *swapchain = new fdw_vk_swapchain();
  if (createSurface(context, *window, &swapchain->surface) != 0) {
    delete swapchain;
    return nullptr;
  }
  VkBool32 supported = VK_FALSE;
  vkGetPhysicalDeviceSurfaceSupportKHR(context->physicalDevice,
                                       context->queueFamily, swapchain->surface,
                                       &supported);
  if (!supported) {
    destroy(context, swapchain);
    fail("The queue of the device cannot present into the window");
    return nullptr;
  }

  // An 8-bit format, written as is: the engine encodes the colors itself.
  uint32_t count = 0;
  vkGetPhysicalDeviceSurfaceFormatsKHR(context->physicalDevice,
                                       swapchain->surface, &count, nullptr);
  std::vector<VkSurfaceFormatKHR> formats(count);
  vkGetPhysicalDeviceSurfaceFormatsKHR(
      context->physicalDevice, swapchain->surface, &count, formats.data());
  for (const auto &[format, name] :
       {std::pair{VK_FORMAT_B8G8R8A8_UNORM, "bgra8unorm"},
        std::pair{VK_FORMAT_R8G8B8A8_UNORM, "rgba8unorm"}}) {
    const bool found =
        std::any_of(formats.begin(), formats.end(), [format](const auto &f) {
          return f.format == format &&
                 f.colorSpace == VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
        });
    if (found && swapchain->format == VK_FORMAT_UNDEFINED) {
      swapchain->format = format;
      swapchain->formatName = name;
    }
  }
  if (swapchain->format == VK_FORMAT_UNDEFINED) {
    destroy(context, swapchain);
    fail("The window offers no 8-bit RGBA or BGRA format");
    return nullptr;
  }

  // FIFO is always there; without vsync, mailbox, else immediate.
  if (!vsync) {
    vkGetPhysicalDeviceSurfacePresentModesKHR(
        context->physicalDevice, swapchain->surface, &count, nullptr);
    std::vector<VkPresentModeKHR> modes(count);
    vkGetPhysicalDeviceSurfacePresentModesKHR(
        context->physicalDevice, swapchain->surface, &count, modes.data());
    for (VkPresentModeKHR mode :
         {VK_PRESENT_MODE_MAILBOX_KHR, VK_PRESENT_MODE_IMMEDIATE_KHR}) {
      if (std::find(modes.begin(), modes.end(), mode) != modes.end()) {
        swapchain->presentMode = mode;
        break;
      }
    }
  }
  if (build(context, swapchain, width, height) != 0) {
    const std::string error = fdw_vk_last_error();
    destroy(context, swapchain);
    fail(error);
    return nullptr;
  }
  context->swapchains.insert(swapchain);
  return swapchain;
}

void fdw_vk_swapchain_destroy(fdw_vk_context *context,
                              fdw_vk_swapchain *swapchain) {
  if (swapchain && context->swapchains.erase(swapchain)) {
    destroy(context, swapchain);
  }
}

const char *fdw_vk_swapchain_format(const fdw_vk_swapchain *swapchain) {
  return swapchain->formatName;
}

void fdw_vk_swapchain_extent(const fdw_vk_swapchain *swapchain,
                             uint32_t *width, uint32_t *height) {
  *width = swapchain->extent.width;
  *height = swapchain->extent.height;
}

uint32_t fdw_vk_swapchain_image_count(const fdw_vk_swapchain *swapchain) {
  return static_cast<uint32_t>(swapchain->images.size());
}

fdw_vk_texture *fdw_vk_swapchain_image(const fdw_vk_swapchain *swapchain,
                                       uint32_t index) {
  return index < swapchain->images.size() ? swapchain->images[index] : nullptr;
}

int fdw_vk_swapchain_acquire(fdw_vk_context *context,
                             fdw_vk_swapchain *swapchain, uint32_t width,
                             uint32_t height, int32_t *recreated) {
  *recreated = 0;
  if (swapchain->current >= 0) {
    return swapchain->current;
  }
  // At most two frames in flight: the one before the last is done.
  const uint64_t waitFor = swapchain->frames[swapchain->frame % 2];
  if (waitFor > 0) {
    VkSemaphoreWaitInfo wait{VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO};
    wait.semaphoreCount = 1;
    wait.pSemaphores = &context->timeline;
    wait.pValues = &waitFor;
    vkWaitSemaphores(context->device, &wait,
                     std::numeric_limits<uint64_t>::max());
  }
  collect(context);

  const bool resized = swapchain->extent.width != width ||
                       swapchain->extent.height != height;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (swapchain->outdated || (attempt == 0 && resized)) {
      if (build(context, swapchain, width, height) != 0) {
        return -1;
      }
      *recreated = 1;
    }
    VkSemaphore semaphore = swapchain->acquired[swapchain->nextAcquired];
    uint32_t index = 0;
    const VkResult result = vkAcquireNextImageKHR(
        context->device, swapchain->swapchain,
        std::numeric_limits<uint64_t>::max(), semaphore, VK_NULL_HANDLE,
        &index);
    if (result == VK_ERROR_OUT_OF_DATE_KHR) {
      swapchain->outdated = true;
      continue;
    }
    if (result != VK_SUCCESS && result != VK_SUBOPTIMAL_KHR) {
      return fail("vkAcquireNextImageKHR", result);
    }
    if (result == VK_SUBOPTIMAL_KHR) {
      // Recreated at the next acquisition.
      swapchain->outdated = true;
    }
    swapchain->nextAcquired =
        (swapchain->nextAcquired + 1) % swapchain->acquired.size();
    // The next submission waits for the image; its content is discarded
    // (the passes clear it), and its first use waits for the acquisition.
    VkSemaphoreSubmitInfo wait{VK_STRUCTURE_TYPE_SEMAPHORE_SUBMIT_INFO};
    wait.semaphore = semaphore;
    wait.stageMask = VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT;
    context->pendingWaits.push_back(wait);
    fdw_vk_texture *texture = swapchain->images[index];
    texture->layout = VK_IMAGE_LAYOUT_UNDEFINED;
    texture->last = {VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, VK_ACCESS_2_NONE};
    swapchain->current = static_cast<int32_t>(index);
    return swapchain->current;
  }
  return fail("The swapchain stays out of date");
}

int fdw_vk_swapchain_present(fdw_vk_context *context,
                             fdw_vk_swapchain *swapchain) {
  if (swapchain->current < 0) {
    return fail("No image acquired to present");
  }
  const uint32_t index = static_cast<uint32_t>(swapchain->current);
  swapchain->current = -1;
  fdw_vk_texture *texture = swapchain->images[index];

  // The image to the layout of the presentation, then signaled.
  VkCommandBuffer commands = transfers(context);
  useTexture(commands, texture, VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
             VK_PIPELINE_STAGE_2_ALL_COMMANDS_BIT, VK_ACCESS_2_NONE);
  const uint64_t submission =
      submit(context, {}, swapchain->rendered[index]);
  if (submission == 0) {
    return -1;
  }
  swapchain->frames[swapchain->frame % 2] = submission;
  swapchain->frame++;

  VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};
  present.waitSemaphoreCount = 1;
  present.pWaitSemaphores = &swapchain->rendered[index];
  present.swapchainCount = 1;
  present.pSwapchains = &swapchain->swapchain;
  present.pImageIndices = &index;
  const VkResult result = vkQueuePresentKHR(context->queue, &present);
  if (result == VK_ERROR_OUT_OF_DATE_KHR || result == VK_SUBOPTIMAL_KHR) {
    swapchain->outdated = true;
    return 0;
  }
  return result == VK_SUCCESS ? 0 : fail("vkQueuePresentKHR", result);
}

} // extern "C"
