// SDL3 implementation of the window API (include/fdw/window.h).

#include "fdw/window.h"

#include <SDL3/SDL.h>

#include <cstring>
#include <string>

struct fdw_window {
  SDL_Window *window = nullptr;
  // Created on first copy presentation: a window presented by Vulkan has
  // none.
  SDL_Renderer *renderer = nullptr;
  SDL_Texture *texture = nullptr;
  int32_t texture_width = 0;
  int32_t texture_height = 0;
  int32_t vsync = 1;
};

namespace {

thread_local std::string last_error;

int fail(const std::string &message) {
  last_error = message;
  return -1;
}

std::string sdl_error(const char *what) {
  return std::string(what) + ": " + SDL_GetError();
}

uint32_t modifiers(SDL_Keymod mod) {
  uint32_t result = 0;
  if (mod & SDL_KMOD_SHIFT) {
    result |= FDW_MOD_SHIFT;
  }
  if (mod & SDL_KMOD_CTRL) {
    result |= FDW_MOD_CTRL;
  }
  if (mod & SDL_KMOD_ALT) {
    result |= FDW_MOD_ALT;
  }
  if (mod & SDL_KMOD_GUI) {
    result |= FDW_MOD_META;
  }
  return result;
}

// SDL buttons (1 left, 2 middle, 3 right…) to DOM buttons (0, 1, 2…).
int32_t dom_button(uint8_t button) { return static_cast<int32_t>(button) - 1; }

// Pointer positions in pixels: SDL gives them in logical units.
float pixel_scale(SDL_WindowID id) {
  SDL_Window *window = SDL_GetWindowFromID(id);
  return window ? SDL_GetWindowPixelDensity(window) : 1.0f;
}

} // namespace

extern "C" {

int fdw_init(void) {
  if (!SDL_InitSubSystem(SDL_INIT_VIDEO)) {
    return fail(sdl_error("SDL_InitSubSystem"));
  }
  return 0;
}

void fdw_quit(void) { SDL_QuitSubSystem(SDL_INIT_VIDEO); }

const char *fdw_last_error(void) { return last_error.c_str(); }

fdw_window *fdw_window_create(const char *title, int32_t width, int32_t height,
                              uint32_t flags) {
  SDL_WindowFlags sdl_flags = SDL_WINDOW_HIGH_PIXEL_DENSITY;
  if (flags & FDW_WINDOW_RESIZABLE) {
    sdl_flags |= SDL_WINDOW_RESIZABLE;
  }
  if (flags & FDW_WINDOW_HIDDEN) {
    sdl_flags |= SDL_WINDOW_HIDDEN;
  }
  if (flags & FDW_WINDOW_FULLSCREEN) {
    sdl_flags |= SDL_WINDOW_FULLSCREEN;
  }
  if (flags & FDW_WINDOW_VULKAN) {
    sdl_flags |= SDL_WINDOW_VULKAN;
  }
  SDL_Window *sdl_window =
      SDL_CreateWindow(title ? title : "", width, height, sdl_flags);
  if (!sdl_window) {
    fail(sdl_error("SDL_CreateWindow"));
    return nullptr;
  }
  auto *window = new fdw_window();
  window->window = sdl_window;
  return window;
}

void fdw_window_destroy(fdw_window *window) {
  if (!window) {
    return;
  }
  if (window->texture) {
    SDL_DestroyTexture(window->texture);
  }
  if (window->renderer) {
    SDL_DestroyRenderer(window->renderer);
  }
  SDL_DestroyWindow(window->window);
  delete window;
}

uint32_t fdw_window_id(const fdw_window *window) {
  return SDL_GetWindowID(window->window);
}

void fdw_window_size(const fdw_window *window, int32_t *width,
                     int32_t *height) {
  int w = 0;
  int h = 0;
  SDL_GetWindowSizeInPixels(window->window, &w, &h);
  *width = w;
  *height = h;
}

void fdw_window_set_title(fdw_window *window, const char *title) {
  SDL_SetWindowTitle(window->window, title ? title : "");
}

int fdw_window_set_vsync(fdw_window *window, int32_t vsync) {
  window->vsync = vsync;
  if (window->renderer && !SDL_SetRenderVSync(window->renderer, vsync)) {
    return fail(sdl_error("SDL_SetRenderVSync"));
  }
  return 0;
}

int fdw_window_present_rgba(fdw_window *window, const void *pixels,
                            int32_t width, int32_t height, int32_t stride) {
  if (!window->renderer) {
    window->renderer = SDL_CreateRenderer(window->window, nullptr);
    if (!window->renderer) {
      return fail(sdl_error("SDL_CreateRenderer"));
    }
    SDL_SetRenderVSync(window->renderer, window->vsync);
  }
  if (!window->texture || window->texture_width != width ||
      window->texture_height != height) {
    if (window->texture) {
      SDL_DestroyTexture(window->texture);
    }
    // RGBA bytes in memory, whatever the endianness.
    window->texture =
        SDL_CreateTexture(window->renderer, SDL_PIXELFORMAT_RGBA32,
                          SDL_TEXTUREACCESS_STREAMING, width, height);
    if (!window->texture) {
      return fail(sdl_error("SDL_CreateTexture"));
    }
    SDL_SetTextureScaleMode(window->texture, SDL_SCALEMODE_NEAREST);
    window->texture_width = width;
    window->texture_height = height;
  }
  if (!SDL_UpdateTexture(window->texture, nullptr, pixels, stride)) {
    return fail(sdl_error("SDL_UpdateTexture"));
  }
  // The image covers the window; its size follows the window, a frame
  // late at most while resizing.
  SDL_RenderTexture(window->renderer, window->texture, nullptr, nullptr);
  if (!SDL_RenderPresent(window->renderer)) {
    return fail(sdl_error("SDL_RenderPresent"));
  }
  return 0;
}

int fdw_poll_event(fdw_event *event) {
  SDL_Event e;
  while (SDL_PollEvent(&e)) {
    std::memset(event, 0, sizeof(*event));
    switch (e.type) {
    case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
      event->type = FDW_EVENT_CLOSE;
      event->window = e.window.windowID;
      return 1;
    case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED:
      event->type = FDW_EVENT_RESIZE;
      event->window = e.window.windowID;
      event->width = e.window.data1;
      event->height = e.window.data2;
      return 1;
    case SDL_EVENT_KEY_DOWN:
    case SDL_EVENT_KEY_UP:
      event->type = e.type == SDL_EVENT_KEY_DOWN ? FDW_EVENT_KEY_DOWN
                                                 : FDW_EVENT_KEY_UP;
      event->window = e.key.windowID;
      std::strncpy(event->key, SDL_GetKeyName(e.key.key),
                   sizeof(event->key) - 1);
      event->repeat = e.key.repeat ? 1 : 0;
      event->modifiers = modifiers(e.key.mod);
      return 1;
    case SDL_EVENT_MOUSE_MOTION: {
      const float scale = pixel_scale(e.motion.windowID);
      event->type = FDW_EVENT_POINTER_MOVE;
      event->window = e.motion.windowID;
      event->x = e.motion.x * scale;
      event->y = e.motion.y * scale;
      event->dx = e.motion.xrel * scale;
      event->dy = e.motion.yrel * scale;
      event->modifiers = modifiers(SDL_GetModState());
      return 1;
    }
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
    case SDL_EVENT_MOUSE_BUTTON_UP: {
      const float scale = pixel_scale(e.button.windowID);
      event->type = e.type == SDL_EVENT_MOUSE_BUTTON_DOWN
                        ? FDW_EVENT_POINTER_DOWN
                        : FDW_EVENT_POINTER_UP;
      event->window = e.button.windowID;
      event->x = e.button.x * scale;
      event->y = e.button.y * scale;
      event->button = dom_button(e.button.button);
      event->modifiers = modifiers(SDL_GetModState());
      return 1;
    }
    case SDL_EVENT_MOUSE_WHEEL:
      event->type = FDW_EVENT_WHEEL;
      event->window = e.wheel.windowID;
      event->x = e.wheel.mouse_x * pixel_scale(e.wheel.windowID);
      event->y = e.wheel.mouse_y * pixel_scale(e.wheel.windowID);
      event->dx = e.wheel.x;
      event->dy = e.wheel.y;
      event->modifiers = modifiers(SDL_GetModState());
      return 1;
    default:
      // Other events are not exposed yet.
      break;
    }
  }
  return 0;
}

} // extern "C"
