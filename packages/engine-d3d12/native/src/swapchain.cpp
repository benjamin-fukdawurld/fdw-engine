// Swapchains: presentation into the windows of the system, by a DXGI flip
// model swapchain.

#include "context.hpp"

#include <array>

using namespace fdw;

struct fdw_dx_swapchain {
  ComPtr<IDXGISwapChain3> swapchain;
  uint32_t width = 0;
  uint32_t height = 0;
  bool vsync = true;
  // Presented without waiting for the display, where it allows it.
  bool tearing = false;
  std::vector<fdw_dx_texture *> images;
  // The image acquired, or -1.
  int32_t current = -1;
  // The submissions of the last frames presented: at most two in flight.
  std::array<uint64_t, 2> frames{};
  uint32_t frame = 0;
};

namespace {

constexpr UINT ImageCount = 3;
constexpr DXGI_FORMAT ImageFormat = DXGI_FORMAT_B8G8R8A8_UNORM;

// Wraps the images as textures of the commands, in the present state.
int wrapImages(fdw_dx_context *context, fdw_dx_swapchain *swapchain) {
  for (UINT i = 0; i < ImageCount; i++) {
    ComPtr<ID3D12Resource> image;
    const HRESULT result = swapchain->swapchain->GetBuffer(i, IID_PPV_ARGS(&image));
    if (FAILED(result)) {
      return fail("IDXGISwapChain::GetBuffer", result);
    }
    fdw_dx_texture *texture = wrapTexture(context, image, "bgra8unorm",
                                          D3D12_RESOURCE_STATE_PRESENT);
    if (!texture) {
      return -1;
    }
    swapchain->images.push_back(texture);
  }
  return 0;
}

void releaseImages(fdw_dx_context *context, fdw_dx_swapchain *swapchain) {
  for (fdw_dx_texture *texture : swapchain->images) {
    context->textures.erase(texture->id);
    destroyTexture(context, texture);
  }
  swapchain->images.clear();
}

UINT flags(const fdw_dx_swapchain *swapchain) {
  return swapchain->tearing ? DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING : 0;
}

} // namespace

namespace fdw {

void destroySwapchains(fdw_dx_context *context) {
  for (fdw_dx_swapchain *swapchain : context->swapchains) {
    releaseImages(context, swapchain);
    delete swapchain;
  }
  context->swapchains.clear();
}

} // namespace fdw

extern "C" {

fdw_dx_swapchain *fdw_dx_swapchain_create(fdw_dx_context *context,
                                          const fdw_dx_window_handle *window,
                                          uint32_t width, uint32_t height,
                                          int32_t vsync) {
  if (window->system != 3 || !window->window) {
    fail("Direct3D 12 presents into Win32 windows only");
    return nullptr;
  }
  auto *swapchain = new fdw_dx_swapchain();
  swapchain->vsync = vsync != 0;
  swapchain->tearing = context->tearing;
  swapchain->width = std::max(width, 1u);
  swapchain->height = std::max(height, 1u);
  const HWND hwnd = reinterpret_cast<HWND>(window->window);
  DXGI_SWAP_CHAIN_DESC1 desc{};
  desc.Width = swapchain->width;
  desc.Height = swapchain->height;
  desc.Format = ImageFormat;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = ImageCount;
  desc.Scaling = DXGI_SCALING_STRETCH;
  desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
  desc.Flags = flags(swapchain);
  ComPtr<IDXGISwapChain1> created;
  HRESULT result = context->factory->CreateSwapChainForHwnd(
      context->queue.Get(), hwnd, &desc, nullptr, nullptr, &created);
  if (SUCCEEDED(result)) {
    result = created.As(&swapchain->swapchain);
  }
  if (FAILED(result)) {
    delete swapchain;
    fail("CreateSwapChainForHwnd", result);
    return nullptr;
  }
  // The window toggles full screen itself.
  context->factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);
  if (wrapImages(context, swapchain) != 0) {
    releaseImages(context, swapchain);
    delete swapchain;
    return nullptr;
  }
  context->swapchains.insert(swapchain);
  return swapchain;
}

void fdw_dx_swapchain_destroy(fdw_dx_context *context,
                              fdw_dx_swapchain *swapchain) {
  if (!swapchain || !context->swapchains.erase(swapchain)) {
    return;
  }
  // The images may be in flight.
  fdw_dx_wait_idle(context);
  releaseImages(context, swapchain);
  delete swapchain;
}

const char *fdw_dx_swapchain_format(const fdw_dx_swapchain *) {
  return "bgra8unorm";
}

int fdw_dx_swapchain_acquire(fdw_dx_context *context,
                             fdw_dx_swapchain *swapchain, uint32_t width,
                             uint32_t height, int32_t *recreated) {
  *recreated = 0;
  if (swapchain->current >= 0) {
    return swapchain->current;
  }
  // At most two frames in flight: the one before the last is done.
  if (waitFor(context, swapchain->frames[swapchain->frame]) != 0) {
    return -1;
  }
  collect(context);
  if (width > 0 && height > 0 &&
      (width != swapchain->width || height != swapchain->height)) {
    // Every reference to the images released, and the GPU done with them.
    if (fdw_dx_wait_idle(context) != 0) {
      return -1;
    }
    releaseImages(context, swapchain);
    const HRESULT result = swapchain->swapchain->ResizeBuffers(
        ImageCount, width, height, ImageFormat, flags(swapchain));
    if (FAILED(result)) {
      return fail("IDXGISwapChain::ResizeBuffers", result);
    }
    swapchain->width = width;
    swapchain->height = height;
    if (wrapImages(context, swapchain) != 0) {
      return -1;
    }
    *recreated = 1;
  }
  swapchain->current =
      static_cast<int32_t>(swapchain->swapchain->GetCurrentBackBufferIndex());
  return swapchain->current;
}

uint32_t fdw_dx_swapchain_image_count(const fdw_dx_swapchain *swapchain) {
  return static_cast<uint32_t>(swapchain->images.size());
}

void fdw_dx_swapchain_extent(const fdw_dx_swapchain *swapchain,
                             uint32_t *width, uint32_t *height) {
  *width = swapchain->width;
  *height = swapchain->height;
}

fdw_dx_texture *fdw_dx_swapchain_image(const fdw_dx_swapchain *swapchain,
                                       uint32_t index) {
  return index < swapchain->images.size() ? swapchain->images[index] : nullptr;
}

int fdw_dx_swapchain_present(fdw_dx_context *context,
                             fdw_dx_swapchain *swapchain) {
  if (swapchain->current < 0) {
    return fail("No image acquired to present");
  }
  // In the present state, after the commands submitted so far.
  fdw_dx_texture *image = swapchain->images[swapchain->current];
  ID3D12GraphicsCommandList *list = transfers(context);
  if (!list) {
    return -1;
  }
  useTexture(context, list, image, D3D12_RESOURCE_STATE_PRESENT);
  const uint64_t submission = submit(context);
  if (submission == 0) {
    return -1;
  }
  const UINT interval = swapchain->vsync ? 1 : 0;
  const UINT present =
      !swapchain->vsync && swapchain->tearing ? DXGI_PRESENT_ALLOW_TEARING : 0;
  const HRESULT result = swapchain->swapchain->Present(interval, present);
  swapchain->current = -1;
  swapchain->frames[swapchain->frame] = submission;
  swapchain->frame = (swapchain->frame + 1) % swapchain->frames.size();
  if (FAILED(result)) {
    return fail("IDXGISwapChain::Present", result);
  }
  return 0;
}

} // extern "C"
