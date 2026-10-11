// SDL3 implementation of the window API (include/fdw/window.h).

#include "fdw/window.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cstring>
#include <map>
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

// The DOM `code` of a scancode: the physical position of a key, the same
// whatever the layout. Empty for the keys without a DOM name here.
std::string dom_code(SDL_Scancode scancode) {
  if (scancode >= SDL_SCANCODE_A && scancode <= SDL_SCANCODE_Z) {
    return std::string("Key") + char('A' + (scancode - SDL_SCANCODE_A));
  }
  if (scancode >= SDL_SCANCODE_1 && scancode <= SDL_SCANCODE_9) {
    return std::string("Digit") + char('1' + (scancode - SDL_SCANCODE_1));
  }
  if (scancode >= SDL_SCANCODE_F1 && scancode <= SDL_SCANCODE_F12) {
    return "F" + std::to_string(1 + scancode - SDL_SCANCODE_F1);
  }
  if (scancode >= SDL_SCANCODE_KP_1 && scancode <= SDL_SCANCODE_KP_9) {
    return std::string("Numpad") + char('1' + (scancode - SDL_SCANCODE_KP_1));
  }
  static const std::map<SDL_Scancode, const char *> names = {
      {SDL_SCANCODE_0, "Digit0"},
      {SDL_SCANCODE_RETURN, "Enter"},
      {SDL_SCANCODE_ESCAPE, "Escape"},
      {SDL_SCANCODE_BACKSPACE, "Backspace"},
      {SDL_SCANCODE_TAB, "Tab"},
      {SDL_SCANCODE_SPACE, "Space"},
      {SDL_SCANCODE_MINUS, "Minus"},
      {SDL_SCANCODE_EQUALS, "Equal"},
      {SDL_SCANCODE_LEFTBRACKET, "BracketLeft"},
      {SDL_SCANCODE_RIGHTBRACKET, "BracketRight"},
      {SDL_SCANCODE_BACKSLASH, "Backslash"},
      {SDL_SCANCODE_NONUSBACKSLASH, "IntlBackslash"},
      {SDL_SCANCODE_SEMICOLON, "Semicolon"},
      {SDL_SCANCODE_APOSTROPHE, "Quote"},
      {SDL_SCANCODE_GRAVE, "Backquote"},
      {SDL_SCANCODE_COMMA, "Comma"},
      {SDL_SCANCODE_PERIOD, "Period"},
      {SDL_SCANCODE_SLASH, "Slash"},
      {SDL_SCANCODE_CAPSLOCK, "CapsLock"},
      {SDL_SCANCODE_PRINTSCREEN, "PrintScreen"},
      {SDL_SCANCODE_SCROLLLOCK, "ScrollLock"},
      {SDL_SCANCODE_PAUSE, "Pause"},
      {SDL_SCANCODE_INSERT, "Insert"},
      {SDL_SCANCODE_HOME, "Home"},
      {SDL_SCANCODE_PAGEUP, "PageUp"},
      {SDL_SCANCODE_DELETE, "Delete"},
      {SDL_SCANCODE_END, "End"},
      {SDL_SCANCODE_PAGEDOWN, "PageDown"},
      {SDL_SCANCODE_RIGHT, "ArrowRight"},
      {SDL_SCANCODE_LEFT, "ArrowLeft"},
      {SDL_SCANCODE_DOWN, "ArrowDown"},
      {SDL_SCANCODE_UP, "ArrowUp"},
      {SDL_SCANCODE_NUMLOCKCLEAR, "NumLock"},
      {SDL_SCANCODE_KP_DIVIDE, "NumpadDivide"},
      {SDL_SCANCODE_KP_MULTIPLY, "NumpadMultiply"},
      {SDL_SCANCODE_KP_MINUS, "NumpadSubtract"},
      {SDL_SCANCODE_KP_PLUS, "NumpadAdd"},
      {SDL_SCANCODE_KP_ENTER, "NumpadEnter"},
      {SDL_SCANCODE_KP_0, "Numpad0"},
      {SDL_SCANCODE_KP_PERIOD, "NumpadDecimal"},
      {SDL_SCANCODE_APPLICATION, "ContextMenu"},
      {SDL_SCANCODE_LCTRL, "ControlLeft"},
      {SDL_SCANCODE_LSHIFT, "ShiftLeft"},
      {SDL_SCANCODE_LALT, "AltLeft"},
      {SDL_SCANCODE_LGUI, "MetaLeft"},
      {SDL_SCANCODE_RCTRL, "ControlRight"},
      {SDL_SCANCODE_RSHIFT, "ShiftRight"},
      {SDL_SCANCODE_RALT, "AltRight"},
      {SDL_SCANCODE_RGUI, "MetaRight"},
  };
  const auto found = names.find(scancode);
  return found != names.end() ? found->second : "";
}

// The gamepads opened, by joystick id.
std::map<SDL_JoystickID, SDL_Gamepad *> gamepads;

// SDL buttons in the order of the standard layout (fdw_gamepad_state); the
// triggers are axes in SDL.
const SDL_GamepadButton standard_buttons[FDW_GAMEPAD_BUTTONS] = {
    SDL_GAMEPAD_BUTTON_SOUTH,          SDL_GAMEPAD_BUTTON_EAST,
    SDL_GAMEPAD_BUTTON_WEST,           SDL_GAMEPAD_BUTTON_NORTH,
    SDL_GAMEPAD_BUTTON_LEFT_SHOULDER,  SDL_GAMEPAD_BUTTON_RIGHT_SHOULDER,
    SDL_GAMEPAD_BUTTON_INVALID,        SDL_GAMEPAD_BUTTON_INVALID,
    SDL_GAMEPAD_BUTTON_BACK,           SDL_GAMEPAD_BUTTON_START,
    SDL_GAMEPAD_BUTTON_LEFT_STICK,     SDL_GAMEPAD_BUTTON_RIGHT_STICK,
    SDL_GAMEPAD_BUTTON_DPAD_UP,        SDL_GAMEPAD_BUTTON_DPAD_DOWN,
    SDL_GAMEPAD_BUTTON_DPAD_LEFT,      SDL_GAMEPAD_BUTTON_DPAD_RIGHT,
    SDL_GAMEPAD_BUTTON_GUIDE,
};

// An axis of SDL (-32768 to 32767), from -1 to 1.
float axis_value(SDL_Gamepad *gamepad, SDL_GamepadAxis axis) {
  return std::max(-1.0f, SDL_GetGamepadAxis(gamepad, axis) / 32767.0f);
}

void close_gamepads() {
  for (const auto &[id, gamepad] : gamepads) {
    SDL_CloseGamepad(gamepad);
  }
  gamepads.clear();
}

} // namespace

extern "C" {

int fdw_init(void) {
  if (!SDL_InitSubSystem(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD)) {
    return fail(sdl_error("SDL_InitSubSystem"));
  }
  return 0;
}

void fdw_quit(void) {
  close_gamepads();
  SDL_QuitSubSystem(SDL_INIT_VIDEO | SDL_INIT_GAMEPAD);
}

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

int fdw_window_native_handle(const fdw_window *window,
                             fdw_window_handle *handle) {
  *handle = {FDW_WINDOW_SYSTEM_UNKNOWN, 0, 0};
  const SDL_PropertiesID properties = SDL_GetWindowProperties(window->window);
  const auto pointer = [properties](const char *name) {
    return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(
        SDL_GetPointerProperty(properties, name, nullptr)));
  };
  if (void *display = SDL_GetPointerProperty(
          properties, SDL_PROP_WINDOW_X11_DISPLAY_POINTER, nullptr)) {
    handle->system = FDW_WINDOW_SYSTEM_X11;
    handle->display = reinterpret_cast<uintptr_t>(display);
    handle->window = static_cast<uint64_t>(SDL_GetNumberProperty(
        properties, SDL_PROP_WINDOW_X11_WINDOW_NUMBER, 0));
  } else if (pointer(SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER)) {
    handle->system = FDW_WINDOW_SYSTEM_WAYLAND;
    handle->display = pointer(SDL_PROP_WINDOW_WAYLAND_DISPLAY_POINTER);
    handle->window = pointer(SDL_PROP_WINDOW_WAYLAND_SURFACE_POINTER);
  } else if (pointer(SDL_PROP_WINDOW_WIN32_HWND_POINTER)) {
    handle->system = FDW_WINDOW_SYSTEM_WIN32;
    handle->display = pointer(SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER);
    handle->window = pointer(SDL_PROP_WINDOW_WIN32_HWND_POINTER);
  } else if (pointer(SDL_PROP_WINDOW_COCOA_WINDOW_POINTER)) {
    handle->system = FDW_WINDOW_SYSTEM_COCOA;
    handle->window = pointer(SDL_PROP_WINDOW_COCOA_WINDOW_POINTER);
  } else {
    return fail("Unknown window system");
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
    case SDL_EVENT_WINDOW_FOCUS_LOST:
      event->type = FDW_EVENT_FOCUS_LOST;
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
      std::strncpy(event->code, dom_code(e.key.scancode).c_str(),
                   sizeof(event->code) - 1);
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
    case SDL_EVENT_GAMEPAD_ADDED:
      if (SDL_Gamepad *gamepad = SDL_OpenGamepad(e.gdevice.which)) {
        gamepads[e.gdevice.which] = gamepad;
        event->type = FDW_EVENT_GAMEPAD_ADDED;
        event->gamepad = e.gdevice.which;
        return 1;
      }
      break;
    case SDL_EVENT_GAMEPAD_REMOVED: {
      const auto found = gamepads.find(e.gdevice.which);
      if (found != gamepads.end()) {
        SDL_CloseGamepad(found->second);
        gamepads.erase(found);
        event->type = FDW_EVENT_GAMEPAD_REMOVED;
        event->gamepad = e.gdevice.which;
        return 1;
      }
      break;
    }
    default:
      // Other events are not exposed yet.
      break;
    }
  }
  return 0;
}

int32_t fdw_gamepads(uint32_t *ids, int32_t capacity) {
  int32_t count = 0;
  for (const auto &[id, gamepad] : gamepads) {
    if (count < capacity) {
      ids[count] = id;
    }
    count++;
  }
  return count;
}

int fdw_gamepad_read(uint32_t id, fdw_gamepad_state *state) {
  const auto found = gamepads.find(id);
  if (found == gamepads.end()) {
    return fail("No gamepad " + std::to_string(id));
  }
  SDL_Gamepad *gamepad = found->second;
  std::memset(state, 0, sizeof(*state));
  if (const char *name = SDL_GetGamepadName(gamepad)) {
    std::strncpy(state->name, name, sizeof(state->name) - 1);
  }
  for (int i = 0; i < FDW_GAMEPAD_BUTTONS; i++) {
    const SDL_GamepadButton button = standard_buttons[i];
    if (button != SDL_GAMEPAD_BUTTON_INVALID) {
      state->buttons[i] = SDL_GetGamepadButton(gamepad, button) ? 1.0f : 0.0f;
    }
  }
  // The triggers, from 0 to 1.
  state->buttons[6] = axis_value(gamepad, SDL_GAMEPAD_AXIS_LEFT_TRIGGER);
  state->buttons[7] = axis_value(gamepad, SDL_GAMEPAD_AXIS_RIGHT_TRIGGER);
  state->axes[0] = axis_value(gamepad, SDL_GAMEPAD_AXIS_LEFTX);
  state->axes[1] = axis_value(gamepad, SDL_GAMEPAD_AXIS_LEFTY);
  state->axes[2] = axis_value(gamepad, SDL_GAMEPAD_AXIS_RIGHTX);
  state->axes[3] = axis_value(gamepad, SDL_GAMEPAD_AXIS_RIGHTY);
  return 0;
}

} // extern "C"
