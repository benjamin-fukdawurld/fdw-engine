// The native viewport of the editor (P18, Linux X11; viewport_win32.cpp for
// Windows): a child X11 window placed in the Electron window over the area
// React reserves. The engine presents into it with its own swapchain
// (@fdw/engine-vulkan), or, on Dawn, gives its frames read back to
// presentViewport, which copies them into the window (XShmPutImage). It
// runs in the engine process (a utility process of Electron), on its JS
// thread, with an X connection of its own: the parent window is known by its
// XID, which X11 shares between processes.
//
// Node-API:
//   createViewport(parent: bigint) -> handle   (getNativeWindowHandle())
//   viewportWindow(handle) -> { system: 'x11', display: bigint, window: bigint }
//   setViewportBounds(handle, x, y, width, height)   (device pixels)
//   setViewportShape(handle, holes: Int32Array)   (x, y, width, height each)
//   pumpViewport(handle)   (each frame: keeps the window above Chromium's)
//   presentViewport(handle, pixels: Uint8Array, width, height, stride)   (RGBA)
//   destroyViewport(handle)

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/shape.h>
#include <node_api.h>
#include <sys/ipc.h>
#include <sys/shm.h>

#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstdlib>
#include <iterator>

namespace {

// The image presentViewport copies the frames into: in a shared memory
// segment (MIT-SHM) when the X server has it, else in the client memory,
// sent whole by XPutImage.
struct Image {
  XImage *image = nullptr;
  XShmSegmentInfo shm{};
  bool shared = false;
};

struct Viewport {
  Display *display = nullptr;
  Window window = 0;
  bool mapped = false;
  GC gc = nullptr;
  Image image;
};

void destroyImage(Display *display, Image &image) {
  if (!image.image) return;
  if (image.shared) {
    XShmDetach(display, &image.shm);
    XSync(display, False);
    shmdt(image.shm.shmaddr);
    image.image->data = nullptr;
  }
  XDestroyImage(image.image);
  image = Image{};
}

void destroy(Viewport *viewport) {
  if (viewport->display) {
    destroyImage(viewport->display, viewport->image);
    if (viewport->gc) XFreeGC(viewport->display, viewport->gc);
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

// The parts of the page drawn over the viewport (menus, floating panels):
// rectangles cut out of the window by its bounding region (Shape), through
// which the page shows. In the coordinates of the window; set again when its
// size changes. None gives the whole window back.
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
  Display *display = viewport->display;
  if (length == 0) {
    XShapeCombineMask(display, viewport->window, ShapeBounding, 0, 0, None,
                      ShapeSet);
  } else {
    Window root;
    int x, y;
    unsigned width, height, border, depth;
    XGetGeometry(display, viewport->window, &root, &x, &y, &width, &height,
                 &border, &depth);
    Region shape = XCreateRegion();
    Region hole = XCreateRegion();
    XRectangle whole{0, 0, uint16_t(std::min(width, 65535u)),
                     uint16_t(std::min(height, 65535u))};
    XUnionRectWithRegion(&whole, shape, shape);
    const auto *values = static_cast<const int32_t *>(data);
    for (size_t i = 0; i < length; i += 4) {
      if (values[i + 2] <= 0 || values[i + 3] <= 0) continue;
      const auto clamp = [](int32_t value) {
        return std::clamp(value, -32768, 32767);
      };
      XRectangle rectangle{
          int16_t(clamp(values[i])), int16_t(clamp(values[i + 1])),
          uint16_t(std::min(values[i + 2], 65535)),
          uint16_t(std::min(values[i + 3], 65535))};
      XUnionRectWithRegion(&rectangle, hole, hole);
    }
    XSubtractRegion(shape, hole, shape);
    XShapeCombineRegion(display, viewport->window, ShapeBounding, 0, 0, shape,
                        ShapeSet);
    XDestroyRegion(hole);
    XDestroyRegion(shape);
  }
  XFlush(display);
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

// Whether XShmAttach failed: the server cannot reach the segment (a remote
// display).
bool attachFailed = false;

int onAttachError(Display *, XErrorEvent *) {
  attachFailed = true;
  return 0;
}

// An image of the window's visual and size, in a shared segment if it can.
bool createImage(Viewport *viewport, unsigned width, unsigned height) {
  Display *display = viewport->display;
  XWindowAttributes attributes;
  XGetWindowAttributes(display, viewport->window, &attributes);
  Image &image = viewport->image;
  if (XShmQueryExtension(display)) {
    image.image =
        XShmCreateImage(display, attributes.visual, unsigned(attributes.depth),
                        ZPixmap, nullptr, &image.shm, width, height);
  }
  if (image.image) {
    const size_t size = size_t(image.image->bytes_per_line) * height;
    image.shm.shmid = shmget(IPC_PRIVATE, size, IPC_CREAT | 0600);
    void *address =
        image.shm.shmid < 0 ? nullptr : shmat(image.shm.shmid, nullptr, 0);
    if (address && address != reinterpret_cast<void *>(-1)) {
      image.shm.shmaddr = image.image->data = static_cast<char *>(address);
      image.shm.readOnly = False;
      attachFailed = false;
      XErrorHandler previous = XSetErrorHandler(onAttachError);
      XShmAttach(display, &image.shm);
      XSync(display, False);
      XSetErrorHandler(previous);
      image.shared = !attachFailed;
      if (!image.shared) shmdt(address);
    }
    // Removed once detached by both sides.
    if (image.shm.shmid >= 0) shmctl(image.shm.shmid, IPC_RMID, nullptr);
    if (!image.shared) {
      image.image->data = nullptr;
      XDestroyImage(image.image);
      image = Image{};
    }
  }
  if (!image.image) {
    image.image =
        XCreateImage(display, attributes.visual, unsigned(attributes.depth),
                     ZPixmap, 0, nullptr, width, height, 32, 0);
    if (!image.image) return false;
    image.image->data = static_cast<char *>(
        std::malloc(size_t(image.image->bytes_per_line) * height));
    if (!image.image->data) {
      XDestroyImage(image.image);
      image = Image{};
      return false;
    }
  }
  if (image.image->bits_per_pixel != 32) {
    destroyImage(display, image);
    return false;
  }
  return true;
}

// A frame of Dawn, read back, copied into the window: each RGBA pixel
// converted to the visual of the window (BGRX on most), alpha opaque.
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

  Display *display = viewport->display;
  Image &image = viewport->image;
  if (image.image &&
      (image.image->width != width || image.image->height != height)) {
    destroyImage(display, image);
  }
  if (!image.image && !createImage(viewport, unsigned(width), unsigned(height)))
    return throwError(env, "presentViewport: no 32-bit image for the window");
  if (!viewport->gc)
    viewport->gc = XCreateGC(display, viewport->window, 0, nullptr);

  XImage *target = image.image;
  const auto shift = [](unsigned long mask) { return std::countr_zero(mask); };
  const int red = shift(target->red_mask), green = shift(target->green_mask),
            blue = shift(target->blue_mask);
  const uint32_t alpha =
      ~uint32_t(target->red_mask | target->green_mask | target->blue_mask);
  const auto *source = static_cast<const uint8_t *>(data);
  for (int32_t y = 0; y < height; ++y) {
    const uint8_t *from = source + size_t(y) * size_t(stride);
    auto *to = reinterpret_cast<uint32_t *>(
        target->data + size_t(y) * size_t(target->bytes_per_line));
    for (int32_t x = 0; x < width; ++x, from += 4) {
      to[x] = uint32_t(from[0]) << red | uint32_t(from[1]) << green |
              uint32_t(from[2]) << blue | alpha;
    }
  }
  if (image.shared) {
    XShmPutImage(display, viewport->window, viewport->gc, target, 0, 0, 0, 0,
                 unsigned(width), unsigned(height), False);
  } else {
    XPutImage(display, viewport->window, viewport->gc, target, 0, 0, 0, 0,
              unsigned(width), unsigned(height));
  }
  // The server has read the segment before the next frame is copied into it.
  XSync(display, False);
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
