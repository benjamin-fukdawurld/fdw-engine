// The native viewport of the editor (P18, Linux X11): a child X11 window
// placed in the Electron window over the area React reserves. The engine
// presents into it with its own swapchain (@fdw/engine-vulkan): this addon
// only owns the window. It runs in the engine process (a utility process of
// Electron), on its JS thread, with an X connection of its own: the parent
// window is known by its XID, which X11 shares between processes.
//
// Node-API:
//   createViewport(parent: bigint) -> handle   (getNativeWindowHandle())
//   viewportWindow(handle) -> { system: 'x11', display: bigint, window: bigint }
//   setViewportBounds(handle, x, y, width, height)   (device pixels)
//   pumpViewport(handle)   (each frame: keeps the window above Chromium's)
//   destroyViewport(handle)

#include <X11/Xlib.h>
#include <X11/extensions/shape.h>
#include <node_api.h>

#include <algorithm>
#include <cstdint>

namespace {

struct Viewport {
  Display *display = nullptr;
  Window window = 0;
  bool mapped = false;
};

void destroy(Viewport *viewport) {
  if (viewport->display) {
    if (viewport->window) XDestroyWindow(viewport->display, viewport->window);
    XCloseDisplay(viewport->display);
  }
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
    return throwError(env, "createViewport: expected the parent XID (bigint)");
  }
  Display *display = XOpenDisplay(nullptr);
  if (!display) return throwError(env, "XOpenDisplay failed");
  auto *viewport = new Viewport{display};
  // The same visual and depth as Electron's window; no background, so that
  // the X server paints nothing between two frames.
  XSetWindowAttributes attributes{};
  attributes.background_pixmap = None;
  viewport->window =
      XCreateWindow(display, Window(parent), 0, 0, 1, 1, 0, CopyFromParent,
                    InputOutput, CopyFromParent, CWBackPixmap, &attributes);
  // An empty input region: the mouse and keyboard reach the page under the
  // viewport, where the editor reads them.
  XShapeCombineRectangles(display, viewport->window, ShapeInput, 0, 0, nullptr,
                          0, ShapeSet, Unsorted);
  XSelectInput(display, Window(parent), SubstructureNotifyMask);
  XSync(display, False);

  auto *handle = new Handle{viewport};
  napi_value result;
  napi_create_external(env, handle, finalizeHandle, nullptr, &result);
  return result;
}

// The window as @fdw/engine-vulkan takes it (NativeWindowHandle).
napi_value viewportWindow(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Viewport *viewport =
      getViewport(env, info, 1, argv, "viewportWindow: expected a viewport");
  if (!viewport) return nullptr;
  napi_value result, system, display, window;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, "x11", NAPI_AUTO_LENGTH, &system);
  napi_create_bigint_uint64(
      env, uint64_t(reinterpret_cast<uintptr_t>(viewport->display)), &display);
  napi_create_bigint_uint64(env, uint64_t(viewport->window), &window);
  napi_set_named_property(env, result, "system", system);
  napi_set_named_property(env, result, "display", display);
  napi_set_named_property(env, result, "window", window);
  return result;
}

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
    XMoveResizeWindow(viewport->display, viewport->window, values[0],
                      values[1], unsigned(width), unsigned(height));
    if (!viewport->mapped) XMapRaised(viewport->display, viewport->window);
    viewport->mapped = true;
  } else if (viewport->mapped) {
    XUnmapWindow(viewport->display, viewport->window);
    viewport->mapped = false;
  }
  // Applied before the next frame: the swapchain takes the new size.
  XSync(viewport->display, False);
  return nullptr;
}

// Chromium draws the page into child windows of its own, recreated when the
// window is resized: they would cover the viewport. Their creation and
// restacking are watched, and the viewport raised above them.
napi_value pumpViewport(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Viewport *viewport =
      getViewport(env, info, 1, argv, "pumpViewport: expected a viewport");
  if (!viewport) return nullptr;
  bool raise = false;
  while (XPending(viewport->display)) {
    XEvent event;
    XNextEvent(viewport->display, &event);
    if (event.type == MapNotify) {
      raise |= event.xmap.window != viewport->window;
    } else if (event.type == ConfigureNotify) {
      raise |= event.xconfigure.window != viewport->window;
    }
  }
  if (raise) {
    XRaiseWindow(viewport->display, viewport->window);
    XFlush(viewport->display);
  }
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
      {"pumpViewport", nullptr, pumpViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"destroyViewport", nullptr, destroyViewport, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, 5, properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
