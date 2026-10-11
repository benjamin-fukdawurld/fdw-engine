// Node-API bindings of the window API: a thin layer, all the logic is in
// the C library (include/fdw/window.h).

#include <node_api.h>

#include <stdlib.h>
#include <string.h>

#include "fdw/window.h"

// The handle given to JavaScript: destroyed explicitly, or when collected.
typedef struct handle {
  fdw_window *window;
} handle;

#define CHECK(call)                                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, NULL, "Node-API call failed: " #call);             \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

static napi_value throw_last_error(napi_env env) {
  napi_throw_error(env, NULL, fdw_last_error());
  return NULL;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static void finalize_handle(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  handle *h = (handle *)data;
  fdw_window_destroy(h->window);
  free(h);
}

// The window of a handle argument; throws when destroyed.
static fdw_window *window_arg(napi_env env, napi_value value) {
  handle *h = NULL;
  if (napi_get_value_external(env, value, (void **)&h) != napi_ok || !h) {
    napi_throw_type_error(env, NULL, "Expected a window handle");
    return NULL;
  }
  if (!h->window) {
    napi_throw_error(env, NULL, "The window was destroyed");
    return NULL;
  }
  return h->window;
}

static int32_t int_arg(napi_env env, napi_value value) {
  int32_t result = 0;
  napi_get_value_int32(env, value, &result);
  return result;
}

// A UTF-8 copy of a string argument, to free.
static char *string_arg(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected a string");
    return NULL;
  }
  char *text = (char *)malloc(length + 1);
  napi_get_value_string_utf8(env, value, text, length + 1, &length);
  return text;
}

static napi_value js_init(napi_env env, napi_callback_info info) {
  (void)info;
  if (fdw_init() != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

static napi_value js_quit(napi_env env, napi_callback_info info) {
  (void)info;
  fdw_quit();
  return undefined(env);
}

// createWindow(title, width, height, flags)
static napi_value js_create_window(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char *title = string_arg(env, argv[0]);
  if (!title) {
    return NULL;
  }
  fdw_window *window =
      fdw_window_create(title, int_arg(env, argv[1]), int_arg(env, argv[2]),
                        (uint32_t)int_arg(env, argv[3]));
  free(title);
  if (!window) {
    return throw_last_error(env);
  }
  handle *h = (handle *)malloc(sizeof(handle));
  h->window = window;
  napi_value result;
  CHECK(napi_create_external(env, h, finalize_handle, NULL, &result));
  return result;
}

static napi_value js_destroy_window(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  handle *h = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&h) == napi_ok && h) {
    fdw_window_destroy(h->window);
    h->window = NULL;
  }
  return undefined(env);
}

static napi_value js_window_id(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  if (!window) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_create_uint32(env, fdw_window_id(window), &result));
  return result;
}

// windowSize(window): [width, height] in pixels.
static napi_value js_window_size(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  if (!window) {
    return NULL;
  }
  int32_t width = 0;
  int32_t height = 0;
  fdw_window_size(window, &width, &height);
  napi_value result, w, h;
  CHECK(napi_create_array_with_length(env, 2, &result));
  CHECK(napi_create_int32(env, width, &w));
  CHECK(napi_create_int32(env, height, &h));
  CHECK(napi_set_element(env, result, 0, w));
  CHECK(napi_set_element(env, result, 1, h));
  return result;
}

static napi_value js_set_title(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  char *title = window ? string_arg(env, argv[1]) : NULL;
  if (!title) {
    return NULL;
  }
  fdw_window_set_title(window, title);
  free(title);
  return undefined(env);
}

static napi_value js_set_vsync(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  if (!window) {
    return NULL;
  }
  if (fdw_window_set_vsync(window, int_arg(env, argv[1])) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// presentRgba(window, pixels: ArrayBufferView, width, height, stride)
static napi_value js_present_rgba(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  if (!window) {
    return NULL;
  }
  bool is_typed_array = false;
  void *data = NULL;
  size_t byte_length = 0;
  CHECK(napi_is_typedarray(env, argv[1], &is_typed_array));
  if (is_typed_array) {
    napi_typedarray_type type;
    size_t length = 0;
    napi_value buffer;
    size_t offset = 0;
    CHECK(napi_get_typedarray_info(env, argv[1], &type, &length, &data,
                                   &buffer, &offset));
    byte_length = type == napi_uint8_array || type == napi_uint8_clamped_array
                      ? length
                      : 0;
  }
  const int32_t width = int_arg(env, argv[2]);
  const int32_t height = int_arg(env, argv[3]);
  const int32_t stride = int_arg(env, argv[4]);
  if (!data || stride < width * 4 ||
      byte_length < (size_t)stride * (size_t)(height - 1) + (size_t)width * 4) {
    napi_throw_range_error(env, NULL,
                           "Expected a Uint8Array of height rows of stride "
                           "bytes, of at least width × 4 bytes");
    return NULL;
  }
  if (fdw_window_present_rgba(window, data, width, height, stride) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

static const char *system_names[] = {"unknown", "x11", "wayland", "win32",
                                     "cocoa"};

// nativeHandle(window): { system, display, window }, the handles as bigints.
static napi_value js_native_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  fdw_window *window = window_arg(env, argv[0]);
  if (!window) {
    return NULL;
  }
  fdw_window_handle handle;
  if (fdw_window_native_handle(window, &handle) != 0) {
    return throw_last_error(env);
  }
  napi_value result, system, display, native;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_create_string_utf8(env, system_names[handle.system],
                                NAPI_AUTO_LENGTH, &system));
  CHECK(napi_create_bigint_uint64(env, handle.display, &display));
  CHECK(napi_create_bigint_uint64(env, handle.window, &native));
  CHECK(napi_set_named_property(env, result, "system", system));
  CHECK(napi_set_named_property(env, result, "display", display));
  CHECK(napi_set_named_property(env, result, "window", native));
  return result;
}

static const char *event_names[] = {
    "none",        "close",       "resize",    "keydown",   "keyup",
    "pointermove", "pointerdown", "pointerup", "wheel",
    "gamepadconnected", "gamepaddisconnected", "blur",
};

static napi_status set_number(napi_env env, napi_value object,
                              const char *name, double value) {
  napi_value number;
  napi_status status = napi_create_double(env, value, &number);
  return status == napi_ok ? napi_set_named_property(env, object, name, number)
                           : status;
}

// pollEvents(): the pending events of every window.
static napi_value js_poll_events(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  CHECK(napi_create_array(env, &result));
  fdw_event event;
  uint32_t count = 0;
  while (fdw_poll_event(&event)) {
    napi_value object, type, key, code;
    CHECK(napi_create_object(env, &object));
    CHECK(napi_create_string_utf8(env, event_names[event.type],
                                  NAPI_AUTO_LENGTH, &type));
    CHECK(napi_set_named_property(env, object, "type", type));
    CHECK(set_number(env, object, "window", event.window));
    switch (event.type) {
    case FDW_EVENT_RESIZE:
      CHECK(set_number(env, object, "width", event.width));
      CHECK(set_number(env, object, "height", event.height));
      break;
    case FDW_EVENT_KEY_DOWN:
    case FDW_EVENT_KEY_UP:
      CHECK(napi_create_string_utf8(env, event.key, NAPI_AUTO_LENGTH, &key));
      CHECK(napi_set_named_property(env, object, "key", key));
      CHECK(napi_create_string_utf8(env, event.code, NAPI_AUTO_LENGTH, &code));
      CHECK(napi_set_named_property(env, object, "code", code));
      CHECK(set_number(env, object, "repeat", event.repeat));
      CHECK(set_number(env, object, "modifiers", event.modifiers));
      break;
    case FDW_EVENT_POINTER_MOVE:
    case FDW_EVENT_POINTER_DOWN:
    case FDW_EVENT_POINTER_UP:
    case FDW_EVENT_WHEEL:
      CHECK(set_number(env, object, "x", event.x));
      CHECK(set_number(env, object, "y", event.y));
      CHECK(set_number(env, object, "dx", event.dx));
      CHECK(set_number(env, object, "dy", event.dy));
      CHECK(set_number(env, object, "button", event.button));
      CHECK(set_number(env, object, "modifiers", event.modifiers));
      break;
    case FDW_EVENT_GAMEPAD_ADDED:
    case FDW_EVENT_GAMEPAD_REMOVED:
      CHECK(set_number(env, object, "gamepad", event.gamepad));
      break;
    default:
      break;
    }
    CHECK(napi_set_element(env, result, count++, object));
  }
  return result;
}

// gamepads(): the ids of the gamepads connected.
static napi_value js_gamepads(napi_env env, napi_callback_info info) {
  (void)info;
  uint32_t ids[16];
  const int32_t count = fdw_gamepads(ids, 16);
  napi_value result;
  CHECK(napi_create_array(env, &result));
  for (int32_t i = 0; i < count && i < 16; i++) {
    napi_value id;
    CHECK(napi_create_uint32(env, ids[i], &id));
    CHECK(napi_set_element(env, result, (uint32_t)i, id));
  }
  return result;
}

// gamepadState(id, buttons, axes): the name of a gamepad, its buttons and
// axes written into two Float32Arrays; undefined when not connected.
static napi_value js_gamepad_state(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t id = 0;
  CHECK(napi_get_value_uint32(env, argv[0], &id));
  fdw_gamepad_state state;
  if (fdw_gamepad_read(id, &state) != 0) {
    return undefined(env);
  }
  napi_value arrays[2] = {argv[1], argv[2]};
  const float *values[2] = {state.buttons, state.axes};
  const size_t counts[2] = {FDW_GAMEPAD_BUTTONS, FDW_GAMEPAD_AXES};
  for (int a = 0; a < 2; a++) {
    napi_typedarray_type type;
    size_t length = 0;
    void *data = NULL;
    CHECK(napi_get_typedarray_info(env, arrays[a], &type, &length, &data, NULL,
                                   NULL));
    if (type != napi_float32_array) {
      napi_throw_type_error(env, NULL, "Expected Float32Arrays");
      return NULL;
    }
    memcpy(data, values[a],
           (length < counts[a] ? length : counts[a]) * sizeof(float));
  }
  napi_value name;
  CHECK(napi_create_string_utf8(env, state.name, NAPI_AUTO_LENGTH, &name));
  return name;
}

static napi_value init_module(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"init", NULL, js_init, NULL, NULL, NULL, napi_default, NULL},
      {"quit", NULL, js_quit, NULL, NULL, NULL, napi_default, NULL},
      {"createWindow", NULL, js_create_window, NULL, NULL, NULL, napi_default,
       NULL},
      {"destroyWindow", NULL, js_destroy_window, NULL, NULL, NULL,
       napi_default, NULL},
      {"windowId", NULL, js_window_id, NULL, NULL, NULL, napi_default, NULL},
      {"windowSize", NULL, js_window_size, NULL, NULL, NULL, napi_default,
       NULL},
      {"setTitle", NULL, js_set_title, NULL, NULL, NULL, napi_default, NULL},
      {"setVsync", NULL, js_set_vsync, NULL, NULL, NULL, napi_default, NULL},
      {"presentRgba", NULL, js_present_rgba, NULL, NULL, NULL, napi_default,
       NULL},
      {"pollEvents", NULL, js_poll_events, NULL, NULL, NULL, napi_default,
       NULL},
      {"nativeHandle", NULL, js_native_handle, NULL, NULL, NULL, napi_default,
       NULL},
      {"gamepads", NULL, js_gamepads, NULL, NULL, NULL, napi_default, NULL},
      {"gamepadState", NULL, js_gamepad_state, NULL, NULL, NULL, napi_default,
       NULL},
  };
  if (napi_define_properties(env, exports,
                             sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init_module)
