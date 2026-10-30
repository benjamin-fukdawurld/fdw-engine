// The native viewport of the editor under Windows (P11, design/
// p11-windows.md §3; viewport_x11.cpp for Linux): a child window of the
// Electron window, placed over the area React reserves. The engine presents
// into it with its own swapchain (Vulkan or Direct3D 12), or, on Dawn, gives
// its frames read back to presentViewport, which copies them into the
// window (SetDIBitsToDevice). It runs in the engine process (a utility
// process of Electron).
//
// A child of a window of another process attaches the input queues of the
// two threads: the window has a thread of its own, which always handles its
// messages, so that a long frame of the JS thread never freezes Electron.
// The window is disabled: the hit test skips it, and the mouse goes to its
// parent, the Electron window, which gives it to the page; it never takes
// the focus, and the keyboard stays with the page.
//
// Node-API (the same as viewport_x11.cpp):
//   createViewport(parent: bigint) -> handle   (getNativeWindowHandle())
//   viewportWindow(handle) -> { system: 'win32', display: bigint, window: bigint }
//   setViewportBounds(handle, x, y, width, height)   (device pixels)
//   setViewportShape(handle, holes: Int32Array)   (x, y, width, height each)
//   pumpViewport(handle)   (each frame: keeps the window above Chromium's)
//   presentViewport(handle, pixels: Uint8Array, width, height, stride)   (RGBA)
//   destroyViewport(handle)

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <node_api.h>

#include <algorithm>
#include <cstdint>
#include <future>
#include <iterator>
#include <thread>
#include <vector>

namespace {

constexpr const wchar_t *className = L"FdwEditorViewport";

struct Viewport {
  HWND parent = nullptr;
  HWND window = nullptr;
  std::thread thread;
  bool shown = false;
  // The frame of Dawn, converted to BGRA.
  std::vector<uint32_t> pixels;
};

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam,
                                 LPARAM lParam) {
  switch (message) {
  // Disabled, the window is skipped by the hit test already; transparent
  // too, should it be asked.
  case WM_NCHITTEST:
    return HTTRANSPARENT;
  case WM_MOUSEACTIVATE:
    return MA_NOACTIVATE;
  // The swapchain paints the window: nothing between two frames.
  case WM_ERASEBKGND:
    return 1;
  case WM_PAINT:
    ValidateRect(window, nullptr);
    return 0;
  case WM_CLOSE:
    DestroyWindow(window);
    return 0;
  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

void registerClass() {
  static const bool registered = [] {
    WNDCLASSEXW windowClass{sizeof(windowClass)};
    windowClass.lpfnWndProc = windowProcedure;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = className;
    return RegisterClassExW(&windowClass) != 0;
  }();
  (void)registered;
}

// The thread of the window: creates it, gives it to createViewport, and
// handles its messages until it is destroyed.
void runWindow(Viewport *viewport, std::promise<HWND> created) {
  // Device pixels, as Chromium: no scaling by Windows between the two.
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  registerClass();
  HWND window = CreateWindowExW(
      WS_EX_NOACTIVATE | WS_EX_NOPARENTNOTIFY, className, L"FDW Viewport",
      WS_CHILD | WS_DISABLED | WS_CLIPSIBLINGS, 0, 0, 1, 1, viewport->parent,
      nullptr, GetModuleHandleW(nullptr), nullptr);
  created.set_value(window);
  if (!window) return;
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
}

void destroy(Viewport *viewport) {
  if (viewport->window) {
    // Destroyed by its thread, which then leaves its loop.
    PostMessageW(viewport->window, WM_CLOSE, 0, 0);
  }
  if (viewport->thread.joinable()) viewport->thread.join();
  delete viewport;
}

// The JS handle: an external to a slot, emptied by destroyViewport.
struct Handle {
  Viewport *viewport = nullptr;
};

void finalizeHandle(napi_env, void *data, void *) {
  auto *handle = static_cast<Handle *>(data);
  if (handle->viewport) destroy(handle->viewport);
  delete handle;
}

napi_value throwError(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

// The viewport of the first argument; null (and a JS exception) when it is
// not a handle, or when the viewport was destroyed.
Viewport *getViewport(napi_env env, napi_callback_info info, size_t expected,
                      napi_value *argv, const char *name) {
  size_t argc = expected;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *data = nullptr;
  if (argc < expected ||
      napi_get_value_external(env, argv[0], &data) != napi_ok) {
    napi_throw_type_error(env, nullptr, name);
    return nullptr;
  }
  auto *viewport = static_cast<Handle *>(data)->viewport;
  if (!viewport) throwError(env, "The viewport was destroyed");
  return viewport;
}

napi_value createViewport(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint64_t parent = 0;
  bool lossless = false;
  if (argc < 1 ||
      napi_get_value_bigint_uint64(env, argv[0], &parent, &lossless) !=
          napi_ok ||
      parent == 0) {
    return throwError(env, "createViewport: expected the parent HWND (bigint)");
  }
  auto *viewport = new Viewport{reinterpret_cast<HWND>(uintptr_t(parent))};
  if (!IsWindow(viewport->parent)) {
    delete viewport;
    return throwError(env, "createViewport: the parent is not a window");
  }
  std::promise<HWND> created;
  std::future<HWND> window = created.get_future();
  viewport->thread = std::thread(runWindow, viewport, std::move(created));
  viewport->window = window.get();
  if (!viewport->window) {
    destroy(viewport);
    return throwError(env, "createViewport: CreateWindowEx failed");
  }

  auto *handle = new Handle{viewport};
  napi_value result;
  napi_create_external(env, handle, finalizeHandle, nullptr, &result);
  return result;
}

// The window as the swapchains take it (NativeWindowHandle).
napi_value viewportWindow(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Viewport *viewport =
      getViewport(env, info, 1, argv, "viewportWindow: expected a viewport");
  if (!viewport) return nullptr;
  napi_value result, system, display, window;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH, &system);
  napi_create_bigint_uint64(
      env, uint64_t(reinterpret_cast<uintptr_t>(GetModuleHandleW(nullptr))),
      &display);
  napi_create_bigint_uint64(
      env, uint64_t(reinterpret_cast<uintptr_t>(viewport->window)), &window);
  napi_set_named_property(env, result, "system", system);
  napi_set_named_property(env, result, "display", display);
  napi_set_named_property(env, result, "window", window);
  return result;
}

// In the client area of the Electron window. SetWindowPos waits for the
// thread of the window: the swapchain takes the new size at the next frame.
napi_value setViewportBounds(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  Viewport *viewport = getViewport(env, info, 5, argv,
                                   "setViewportBounds: expected a viewport");
  if (!viewport) return nullptr;
  int32_t values[4];
  for (int i = 0; i < 4; ++i) {
    if (napi_get_value_int32(env, argv[i + 1], &values[i]) != napi_ok) {
      return throwError(env, "setViewportBounds: expected numbers");
    }
  }
  const int width = std::max(values[2], 0), height = std::max(values[3], 0);
  if (width > 0 && height > 0) {
    SetWindowPos(viewport->window, HWND_TOP, values[0], values[1], width,
                 height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    viewport->shown = true;
  } else if (viewport->shown) {
    SetWindowPos(viewport->window, nullptr, 0, 0, 0, 0,
                 SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                     SWP_HIDEWINDOW);
    viewport->shown = false;
  }
  return nullptr;
}

// The parts of the page drawn over the viewport (menus, floating panels):
// rectangles cut out of the window region, through which the page shows. In
// the coordinates of the window; set again when its size changes. None gives
// the whole window back.
napi_value setViewportShape(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  Viewport *viewport =
      getViewport(env, info, 2, argv, "setViewportShape: expected a viewport");
  if (!viewport) return nullptr;
  bool isTypedArray = false;
  napi_typedarray_type type = napi_int8_array;
  size_t length = 0;
  void *data = nullptr;
  napi_is_typedarray(env, argv[1], &isTypedArray);
  if (isTypedArray) {
    napi_get_typedarray_info(env, argv[1], &type, &length, &data, nullptr,
                             nullptr);
  }
  if (!isTypedArray || type != napi_int32_array || length % 4 != 0) {
    napi_throw_type_error(env, nullptr,
                          "setViewportShape: expected an Int32Array of "
                          "x, y, width, height");
    return nullptr;
  }
  if (length == 0) {
    SetWindowRgn(viewport->window, nullptr, TRUE);
    return nullptr;
  }
  RECT client;
  GetClientRect(viewport->window, &client);
  HRGN shape = CreateRectRgn(0, 0, client.right, client.bottom);
  const auto *values = static_cast<const int32_t *>(data);
  for (size_t i = 0; i < length; i += 4) {
    if (values[i + 2] <= 0 || values[i + 3] <= 0) continue;
    HRGN hole = CreateRectRgn(values[i], values[i + 1],
                              values[i] + values[i + 2],
                              values[i + 1] + values[i + 3]);
    CombineRgn(shape, shape, hole, RGN_DIFF);
    DeleteObject(hole);
  }
  // The window owns the region from now on.
  if (!SetWindowRgn(viewport->window, shape, TRUE)) DeleteObject(shape);
  return nullptr;
}

// Chromium has child windows of its own (for the accessibility): the
// viewport is put back first among its siblings when one went above it.
napi_value pumpViewport(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Viewport *viewport =
      getViewport(env, info, 1, argv, "pumpViewport: expected a viewport");
  if (!viewport) return nullptr;
  if (viewport->shown && GetWindow(viewport->parent, GW_CHILD) !=
                             viewport->window) {
    SetWindowPos(viewport->window, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
  }
  return nullptr;
}

// A frame of Dawn, read back, copied into the window: each RGBA pixel
// converted to BGRA, alpha opaque.
napi_value presentViewport(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  Viewport *viewport =
      getViewport(env, info, 5, argv, "presentViewport: expected a viewport");
  if (!viewport) return nullptr;
  bool isTypedArray = false;
  napi_typedarray_type type = napi_int8_array;
  size_t length = 0;
  void *data = nullptr;
  napi_is_typedarray(env, argv[1], &isTypedArray);
  if (isTypedArray) {
    napi_get_typedarray_info(env, argv[1], &type, &length, &data, nullptr,
                             nullptr);
  }
  int32_t size[3];
  for (int i = 0; i < 3; ++i) {
    if (napi_get_value_int32(env, argv[i + 2], &size[i]) != napi_ok) {
      return throwError(env, "presentViewport: expected numbers");
    }
  }
  const int32_t width = size[0], height = size[1], stride = size[2];
  if (!isTypedArray || type != napi_uint8_array || width <= 0 || height <= 0 ||
      stride < width * 4 ||
      length < size_t(stride) * size_t(height - 1) + size_t(width) * 4) {
    napi_throw_range_error(env, nullptr,
                           "presentViewport: expected a Uint8Array of height "
                           "rows of stride bytes, of at least width × 4 bytes");
    return nullptr;
  }

  std::vector<uint32_t> &pixels = viewport->pixels;
  pixels.resize(size_t(width) * size_t(height));
  const auto *source = static_cast<const uint8_t *>(data);
  for (int32_t y = 0; y < height; ++y) {
    const uint8_t *from = source + size_t(y) * size_t(stride);
    uint32_t *to = pixels.data() + size_t(y) * size_t(width);
    for (int32_t x = 0; x < width; ++x, from += 4) {
      to[x] = uint32_t(from[2]) | uint32_t(from[1]) << 8 |
              uint32_t(from[0]) << 16 | 0xff000000u;
    }
  }
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(bitmap.bmiHeader);
  bitmap.bmiHeader.biWidth = width;
  // Top-down rows.
  bitmap.bmiHeader.biHeight = -height;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  bitmap.bmiHeader.biCompression = BI_RGB;
  HDC context = GetDC(viewport->window);
  SetDIBitsToDevice(context, 0, 0, DWORD(width), DWORD(height), 0, 0, 0,
                    UINT(height), pixels.data(), &bitmap, DIB_RGB_COLORS);
  ReleaseDC(viewport->window, context);
  return nullptr;
}

// After the swapchain on the window is destroyed.
napi_value destroyViewport(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void *data = nullptr;
  if (argc < 1 || napi_get_value_external(env, argv[0], &data) != napi_ok) {
    return throwError(env, "destroyViewport: expected a viewport");
  }
  auto *handle = static_cast<Handle *>(data);
  if (handle->viewport) {
    destroy(handle->viewport);
    handle->viewport = nullptr;
  }
  return nullptr;
}

napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"createViewport", nullptr, createViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"viewportWindow", nullptr, viewportWindow, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"setViewportBounds", nullptr, setViewportBounds, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"setViewportShape", nullptr, setViewportShape, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"pumpViewport", nullptr, pumpViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"presentViewport", nullptr, presentViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"destroyViewport", nullptr, destroyViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, std::size(properties), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
