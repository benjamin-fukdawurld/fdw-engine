// Native windows of the engine: a C API over SDL3, usable from any host
// (the Node-API addon of @fdw/engine-native, a FFI, a native application).
// Every function runs on the thread that called fdw_init.

#ifndef FDW_WINDOW_H
#define FDW_WINDOW_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define FDW_API __declspec(dllexport)
#else
#define FDW_API __attribute__((visibility("default")))
#endif

typedef struct fdw_window fdw_window;

// Window creation flags.
enum {
  FDW_WINDOW_RESIZABLE = 1 << 0,
  FDW_WINDOW_HIDDEN = 1 << 1,
  FDW_WINDOW_FULLSCREEN = 1 << 2,
  // The window will get a Vulkan surface (no copy presentation then).
  FDW_WINDOW_VULKAN = 1 << 3,
};

typedef enum fdw_event_type {
  FDW_EVENT_NONE = 0,
  // The user asked to close the window.
  FDW_EVENT_CLOSE,
  // The size of the window in pixels changed.
  FDW_EVENT_RESIZE,
  FDW_EVENT_KEY_DOWN,
  FDW_EVENT_KEY_UP,
  FDW_EVENT_POINTER_MOVE,
  FDW_EVENT_POINTER_DOWN,
  FDW_EVENT_POINTER_UP,
  FDW_EVENT_WHEEL,
} fdw_event_type;

// Modifier keys, in fdw_event.modifiers.
enum {
  FDW_MOD_SHIFT = 1 << 0,
  FDW_MOD_CTRL = 1 << 1,
  FDW_MOD_ALT = 1 << 2,
  FDW_MOD_META = 1 << 3,
};

typedef struct fdw_event {
  fdw_event_type type;
  // The window of the event (fdw_window_id).
  uint32_t window;
  // FDW_EVENT_RESIZE: the new size, in pixels.
  int32_t width;
  int32_t height;
  // Pointer events: position in pixels from the top left corner, and its
  // movement; FDW_EVENT_WHEEL: the scroll amounts.
  float x;
  float y;
  float dx;
  float dy;
  // Pointer buttons, as in the DOM: 0 main, 1 middle, 2 secondary.
  int32_t button;
  // Key events: the key name (SDL_GetKeyName: "A", "Escape", "Left"…),
  // whether the key repeats, and the modifiers.
  char key[32];
  int32_t repeat;
  uint32_t modifiers;
} fdw_event;

// Initializes the video subsystem. Returns 0, or -1 (see fdw_last_error).
FDW_API int fdw_init(void);
// Releases what fdw_init initialized.
FDW_API void fdw_quit(void);
// The message of the last error of the calling thread.
FDW_API const char *fdw_last_error(void);

// Creates a window of the given size in logical units (its size in pixels
// can be larger on high density displays). Returns NULL on error.
FDW_API fdw_window *fdw_window_create(const char *title, int32_t width,
                                      int32_t height, uint32_t flags);
FDW_API void fdw_window_destroy(fdw_window *window);
FDW_API uint32_t fdw_window_id(const fdw_window *window);
// The size of the window in pixels: the size of its images.
FDW_API void fdw_window_size(const fdw_window *window, int32_t *width,
                             int32_t *height);
FDW_API void fdw_window_set_title(fdw_window *window, const char *title);

// Copies an image (RGBA, 8 bits per channel, rows from the top, `stride`
// bytes apart) to the window, scaled to its size, and shows it. Waits for
// the vertical synchronization when `vsync` was not disabled. Returns 0, or
// -1 on error.
FDW_API int fdw_window_present_rgba(fdw_window *window, const void *pixels,
                                    int32_t width, int32_t height,
                                    int32_t stride);
// Copy presentation: waits for the vertical synchronization (1, default)
// or not (0).
FDW_API int fdw_window_set_vsync(fdw_window *window, int32_t vsync);

// Takes the next pending event of any window. Returns 1 with an event, 0
// when there is none.
FDW_API int fdw_poll_event(fdw_event *event);

#ifdef __cplusplus
}
#endif

#endif
