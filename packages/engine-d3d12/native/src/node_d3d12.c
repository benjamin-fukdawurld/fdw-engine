// Node-API bindings of the Direct3D 12 library: a thin layer, all the logic is in
// the C library (include/fdw/d3d12.h).

#include <node_api.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fdw/d3d12.h"

// The handle of a context: destroyed explicitly, or when collected.
typedef struct context_handle {
  fdw_dx_context *context;
} context_handle;

// The handle of an object (buffer, texture…) keeps its context alive (a
// strong reference), so that the context outlives it.
typedef struct object_handle {
  context_handle *owner;
  napi_ref owner_ref;
  int kind;
  void *object;
} object_handle;

#define CHECK(call)                                                            \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      napi_throw_error(env, NULL, "Node-API call failed: " #call);             \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

#define ARGS(count)                                                            \
  size_t argc = (count);                                                       \
  napi_value argv[(count) > 0 ? (count) : 1];                                  \
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL))

static napi_value throw_last_error(napi_env env) {
  napi_throw_error(env, NULL, fdw_dx_last_error());
  return NULL;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value number(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

static double number_arg(napi_env env, napi_value value) {
  double result = 0;
  napi_get_value_double(env, value, &result);
  return result;
}

// A UTF-8 copy of a string argument (NULL for null or undefined), to free.
static char *string_arg(napi_env env, napi_value value) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type != napi_string) {
    return NULL;
  }
  size_t length = 0;
  napi_get_value_string_utf8(env, value, NULL, 0, &length);
  char *text = (char *)malloc(length + 1);
  napi_get_value_string_utf8(env, value, text, length + 1, &length);
  return text;
}

// The bytes of a typed array or DataView argument.
static int bytes_arg(napi_env env, napi_value value, void **data,
                     size_t *length) {
  bool is = false;
  napi_is_typedarray(env, value, &is);
  if (is) {
    napi_typedarray_type type;
    size_t count = 0;
    napi_value buffer;
    size_t offset = 0;
    napi_get_typedarray_info(env, value, &type, &count, data, &buffer, &offset);
    static const size_t sizes[] = {1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8, 2};
    *length = count * (type < sizeof(sizes) / sizeof(sizes[0]) ? sizes[type]
                                                                : 1);
    return 0;
  }
  napi_is_dataview(env, value, &is);
  if (is) {
    napi_value buffer;
    size_t offset = 0;
    napi_get_dataview_info(env, value, length, data, &buffer, &offset);
    return 0;
  }
  napi_throw_type_error(env, NULL, "Expected a typed array or a DataView");
  return -1;
}

// --- Context -----------------------------------------------------------------

static void finalize_context(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  context_handle *handle = (context_handle *)data;
  fdw_dx_context_destroy(handle->context);
  free(handle);
}

static fdw_dx_context *context_arg(napi_env env, napi_value value) {
  context_handle *handle = NULL;
  if (napi_get_value_external(env, value, (void **)&handle) != napi_ok ||
      !handle) {
    napi_throw_type_error(env, NULL, "Expected a Direct3D 12 context");
    return NULL;
  }
  if (!handle->context) {
    napi_throw_error(env, NULL, "The Direct3D 12 context was destroyed");
    return NULL;
  }
  return handle->context;
}

// createContext(validation, application, warp)
static napi_value js_create_context(napi_env env, napi_callback_info info) {
  ARGS(3);
  bool validation = false, warp = false;
  napi_get_value_bool(env, argv[0], &validation);
  napi_get_value_bool(env, argv[2], &warp);
  char *application = string_arg(env, argv[1]);
  fdw_dx_context_options options = {validation ? 1 : 0, application,
                                    warp ? 1 : 0};
  fdw_dx_context *context = fdw_dx_context_create(&options);
  free(application);
  if (!context) {
    return throw_last_error(env);
  }
  context_handle *handle = (context_handle *)malloc(sizeof(context_handle));
  handle->context = context;
  napi_value result;
  CHECK(napi_create_external(env, handle, finalize_context, NULL, &result));
  return result;
}

static napi_value js_destroy_context(napi_env env, napi_callback_info info) {
  ARGS(1);
  context_handle *handle = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&handle) == napi_ok &&
      handle) {
    fdw_dx_context_destroy(handle->context);
    handle->context = NULL;
  }
  return undefined(env);
}

static napi_value js_device_name(napi_env env, napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_create_string_utf8(env, fdw_dx_device_name(context),
                                NAPI_AUTO_LENGTH, &result));
  return result;
}

static napi_value js_validation_enabled(napi_env env,
                                        napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_get_boolean(env, fdw_dx_validation_enabled(context) != 0,
                         &result));
  return result;
}

// takeMessages(context): the validation messages, then clears them.
static napi_value js_take_messages(napi_env env, napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  const size_t count = fdw_dx_message_count(context);
  napi_value result;
  CHECK(napi_create_array_with_length(env, count, &result));
  for (size_t i = 0; i < count; i++) {
    napi_value message;
    CHECK(napi_create_string_utf8(env, fdw_dx_message(context, i),
                                  NAPI_AUTO_LENGTH, &message));
    CHECK(napi_set_element(env, result, (uint32_t)i, message));
  }
  fdw_dx_clear_messages(context);
  return result;
}

static napi_value js_wait_idle(napi_env env, napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  if (fdw_dx_wait_idle(context) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

static napi_value js_flush(napi_env env, napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  if (fdw_dx_flush(context) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// --- Objects -------------------------------------------------------------------

// The kinds of objects behind a handle.
typedef enum object_kind {
  BUFFER,
  TEXTURE,
  SAMPLER,
  SHADER,
  LAYOUT,
  GROUP,
  PIPELINE,
  SWAPCHAIN,
  QUERY_POOL,
  BOTTOM_LEVEL,
  TOP_LEVEL
} object_kind;

static const char *kind_names[] = {"buffer",       "texture", "sampler",
                                   "shader",       "group layout", "group",
                                   "pipeline",     "swapchain", "query pool",
                                   "bottom level", "top level"};

static void finalize_object(napi_env env, void *data, void *hint) {
  (void)hint;
  object_handle *handle = (object_handle *)data;
  // Without explicit destroy, the object lives as long as its context.
  napi_delete_reference(env, handle->owner_ref);
  free(handle);
}

// A handle of an object of a context, keeping the context alive.
static napi_value wrap_object(napi_env env, napi_value context_value,
                              context_handle *owner, object_kind kind,
                              void *object) {
  object_handle *handle = (object_handle *)malloc(sizeof(object_handle));
  handle->owner = owner;
  handle->kind = (int)kind;
  handle->object = object;
  CHECK(napi_create_reference(env, context_value, 1, &handle->owner_ref));
  napi_value result;
  CHECK(napi_create_external(env, handle, finalize_object, NULL, &result));
  return result;
}

static object_handle *object_arg(napi_env env, napi_value value,
                                 object_kind kind) {
  object_handle *handle = NULL;
  if (napi_get_value_external(env, value, (void **)&handle) != napi_ok ||
      !handle || handle->kind != (int)kind) {
    char message[64];
    snprintf(message, sizeof(message), "Expected a Direct3D 12 %s",
             kind_names[kind]);
    napi_throw_type_error(env, NULL, message);
    return NULL;
  }
  if (!handle->object || !handle->owner->context) {
    char message[64];
    snprintf(message, sizeof(message), "The %s was destroyed",
             kind_names[kind]);
    napi_throw_error(env, NULL, message);
    return NULL;
  }
  return handle;
}

static context_handle *owner_arg(napi_env env, napi_value value) {
  context_handle *owner = NULL;
  if (napi_get_value_external(env, value, (void **)&owner) != napi_ok ||
      !owner || !owner->context) {
    napi_throw_type_error(env, NULL, "Expected a Direct3D 12 context");
    return NULL;
  }
  return owner;
}

// Destroys the object of a handle (once the GPU no longer uses it).
static napi_value destroy_object(napi_env env, napi_callback_info info,
                                 object_kind kind) {
  ARGS(1);
  object_handle *handle = NULL;
  if (napi_get_value_external(env, argv[0], (void **)&handle) != napi_ok ||
      !handle || handle->kind != (int)kind) {
    return undefined(env);
  }
  if (handle->object && handle->owner->context) {
    switch (kind) {
    case BUFFER:
      fdw_dx_buffer_destroy(handle->owner->context, handle->object);
      break;
    case TEXTURE:
      fdw_dx_texture_destroy(handle->owner->context, handle->object);
      break;
    case SAMPLER:
      fdw_dx_sampler_destroy(handle->owner->context, handle->object);
      break;
    case SHADER:
      fdw_dx_shader_destroy(handle->owner->context, handle->object);
      break;
    case GROUP:
      fdw_dx_group_destroy(handle->owner->context, handle->object);
      break;
    case PIPELINE:
      fdw_dx_pipeline_destroy(handle->owner->context, handle->object);
      break;
    case LAYOUT:
      // Group layouts live as long as their context.
      break;
    case SWAPCHAIN:
      fdw_dx_swapchain_destroy(handle->owner->context, handle->object);
      break;
    case QUERY_POOL:
      fdw_dx_query_pool_destroy(handle->owner->context, handle->object);
      break;
    case BOTTOM_LEVEL:
      fdw_dx_bottom_level_destroy(handle->owner->context, handle->object);
      break;
    case TOP_LEVEL:
      fdw_dx_top_level_destroy(handle->owner->context, handle->object);
      break;
    }
  }
  handle->object = NULL;
  return undefined(env);
}

// The id of the object of a handle, for the commands.
static napi_value object_id(napi_env env, napi_callback_info info,
                            object_kind kind) {
  ARGS(1);
  object_handle *handle = object_arg(env, argv[0], kind);
  if (!handle) {
    return NULL;
  }
  switch (kind) {
  case BUFFER:
    return number(env, fdw_dx_buffer_id(handle->object));
  case TEXTURE:
    return number(env, fdw_dx_texture_id(handle->object));
  case SAMPLER:
    return number(env, fdw_dx_sampler_id(handle->object));
  case LAYOUT:
    return number(env, fdw_dx_group_layout_id(handle->object));
  case GROUP:
    return number(env, fdw_dx_group_id(handle->object));
  case PIPELINE:
    return number(env, fdw_dx_pipeline_id(handle->object));
  case QUERY_POOL:
    return number(env, fdw_dx_query_pool_id(handle->object));
  case BOTTOM_LEVEL:
    return number(env, fdw_dx_bottom_level_id(handle->object));
  case TOP_LEVEL:
    return number(env, fdw_dx_top_level_id(handle->object));
  case SHADER:
  case SWAPCHAIN:
    break;
  }
  return NULL;
}

// --- Buffers -------------------------------------------------------------------

// createBuffer(context, size, usage, label)
static napi_value js_create_buffer(napi_env env, napi_callback_info info) {
  ARGS(4);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  char *label = string_arg(env, argv[3]);
  fdw_dx_buffer *buffer = fdw_dx_buffer_create(
      owner->context, (uint64_t)number_arg(env, argv[1]),
      (uint32_t)number_arg(env, argv[2]), label);
  free(label);
  if (!buffer) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, BUFFER, buffer);
}

static napi_value js_destroy_buffer(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, BUFFER);
}

static napi_value js_buffer_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, BUFFER);
}

// writeBuffer(buffer, offset, data)
static napi_value js_write_buffer(napi_env env, napi_callback_info info) {
  ARGS(3);
  object_handle *handle = object_arg(env, argv[0], BUFFER);
  void *data = NULL;
  size_t length = 0;
  if (!handle || bytes_arg(env, argv[2], &data, &length) != 0) {
    return NULL;
  }
  if (fdw_dx_buffer_write(handle->owner->context, handle->object,
                          (uint64_t)number_arg(env, argv[1]), data,
                          length) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// readBuffer(buffer, offset, size): a ticket.
static napi_value js_read_buffer(napi_env env, napi_callback_info info) {
  ARGS(3);
  object_handle *handle = object_arg(env, argv[0], BUFFER);
  if (!handle) {
    return NULL;
  }
  uint64_t ticket = 0;
  if (fdw_dx_buffer_read(handle->owner->context, handle->object,
                         (uint64_t)number_arg(env, argv[1]),
                         (uint64_t)number_arg(env, argv[2]), &ticket) != 0) {
    return throw_last_error(env);
  }
  return number(env, (double)ticket);
}

// readReady(context, ticket): whether the data is there.
static napi_value js_read_ready(napi_env env, napi_callback_info info) {
  ARGS(2);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  const int ready =
      fdw_dx_read_ready(context, (uint64_t)number_arg(env, argv[1]));
  if (ready < 0) {
    return throw_last_error(env);
  }
  napi_value result;
  CHECK(napi_get_boolean(env, ready == 1, &result));
  return result;
}

// readTake(context, ticket, target): copies the data into the target.
static napi_value js_read_take(napi_env env, napi_callback_info info) {
  ARGS(3);
  fdw_dx_context *context = context_arg(env, argv[0]);
  void *data = NULL;
  size_t length = 0;
  if (!context || bytes_arg(env, argv[2], &data, &length) != 0) {
    return NULL;
  }
  if (fdw_dx_read_take(context, (uint64_t)number_arg(env, argv[1]), data,
                       length) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// --- Textures and samplers -----------------------------------------------------

// createTexture(context, format, type, width, height, layers, sampleCount,
// mipLevelCount, usage, label)
static napi_value js_create_texture(napi_env env, napi_callback_info info) {
  ARGS(10);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  char *format = string_arg(env, argv[1]);
  char *type = string_arg(env, argv[2]);
  char *label = string_arg(env, argv[9]);
  fdw_dx_texture_options options = {
      format,
      type,
      (uint32_t)number_arg(env, argv[3]),
      (uint32_t)number_arg(env, argv[4]),
      (uint32_t)number_arg(env, argv[5]),
      (uint32_t)number_arg(env, argv[6]),
      (uint32_t)number_arg(env, argv[7]),
      (uint32_t)number_arg(env, argv[8]),
      label,
  };
  fdw_dx_texture *texture = fdw_dx_texture_create(owner->context, &options);
  free(format);
  free(type);
  free(label);
  if (!texture) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, TEXTURE, texture);
}

static napi_value js_destroy_texture(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, TEXTURE);
}

static napi_value js_texture_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, TEXTURE);
}

// timestampsSupported(context): whether the queue writes timestamps.
static napi_value js_timestamps_supported(napi_env env,
                                          napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_get_boolean(env, fdw_dx_timestamps_supported(context) != 0,
                         &result));
  return result;
}

// createQueryPool(context, count): a pool of timestamp queries.
static napi_value js_create_query_pool(napi_env env, napi_callback_info info) {
  ARGS(2);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  fdw_dx_query_pool *pool = fdw_dx_query_pool_create(
      owner->context, (uint32_t)number_arg(env, argv[1]));
  if (!pool) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, QUERY_POOL, pool);
}

static napi_value js_destroy_query_pool(napi_env env,
                                        napi_callback_info info) {
  return destroy_object(env, info, QUERY_POOL);
}

static napi_value js_query_pool_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, QUERY_POOL);
}

// readQueryPool(pool, first, count, nanoseconds): the timestamps into a
// Float64Array, without waiting; whether all of them were available.
static napi_value js_read_query_pool(napi_env env, napi_callback_info info) {
  ARGS(4);
  object_handle *handle = object_arg(env, argv[0], QUERY_POOL);
  void *data = NULL;
  size_t length = 0;
  if (!handle || bytes_arg(env, argv[3], &data, &length) != 0) {
    return NULL;
  }
  const uint32_t count = (uint32_t)number_arg(env, argv[2]);
  if (length < count * sizeof(double)) {
    napi_throw_range_error(env, NULL, "The array is too small");
    return NULL;
  }
  const int ready = fdw_dx_query_pool_read(
      handle->owner->context, handle->object,
      (uint32_t)number_arg(env, argv[1]), count, (double *)data);
  if (ready < 0) {
    return throw_last_error(env);
  }
  napi_value result;
  CHECK(napi_get_boolean(env, ready == 1, &result));
  return result;
}

// writeTexture(texture, data): every layer, rows from the top.
static napi_value js_write_texture(napi_env env, napi_callback_info info) {
  ARGS(2);
  object_handle *handle = object_arg(env, argv[0], TEXTURE);
  void *data = NULL;
  size_t length = 0;
  if (!handle || bytes_arg(env, argv[1], &data, &length) != 0) {
    return NULL;
  }
  if (fdw_dx_texture_write(handle->owner->context, handle->object, data,
                           length) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// writeTextureLevel(texture, data, level, layer, layerCount): the layers
// [layer, layer + layerCount) of a level, rows from the top (of blocks for
// the compressed formats).
static napi_value js_write_texture_level(napi_env env,
                                         napi_callback_info info) {
  ARGS(5);
  object_handle *handle = object_arg(env, argv[0], TEXTURE);
  void *data = NULL;
  size_t length = 0;
  if (!handle || bytes_arg(env, argv[1], &data, &length) != 0) {
    return NULL;
  }
  if (fdw_dx_texture_write_level(handle->owner->context, handle->object,
                                 (uint32_t)number_arg(env, argv[2]),
                                 (uint32_t)number_arg(env, argv[3]),
                                 (uint32_t)number_arg(env, argv[4]), data,
                                 length) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// generateMipmaps(texture): its levels after the first one, in the order
// of the queue.
static napi_value js_generate_mipmaps(napi_env env, napi_callback_info info) {
  ARGS(1);
  object_handle *handle = object_arg(env, argv[0], TEXTURE);
  if (!handle) {
    return NULL;
  }
  if (fdw_dx_texture_generate_mipmaps(handle->owner->context,
                                      handle->object) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// readTexture(texture, x, y, width, height): a ticket for the pixels of a
// region of the first layer.
static napi_value js_read_texture(napi_env env, napi_callback_info info) {
  ARGS(5);
  object_handle *handle = object_arg(env, argv[0], TEXTURE);
  if (!handle) {
    return NULL;
  }
  uint64_t ticket = 0;
  if (fdw_dx_texture_read(handle->owner->context, handle->object,
                          (uint32_t)number_arg(env, argv[1]),
                          (uint32_t)number_arg(env, argv[2]),
                          (uint32_t)number_arg(env, argv[3]),
                          (uint32_t)number_arg(env, argv[4]), &ticket) != 0) {
    return throw_last_error(env);
  }
  return number(env, (double)ticket);
}

// createSampler(context, minFilter, magFilter, mipmapFilter, wrapU, wrapV,
// wrapW, maxAnisotropy, compare, label)
static napi_value js_create_sampler(napi_env env, napi_callback_info info) {
  ARGS(10);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  char *strings[9] = {NULL};
  for (int i = 0; i < 6; i++) {
    strings[i] = string_arg(env, argv[1 + i]);
  }
  strings[6] = string_arg(env, argv[8]);
  strings[7] = string_arg(env, argv[9]);
  fdw_dx_sampler_options options = {
      strings[0], strings[1], strings[2], strings[3], strings[4],
      strings[5], (float)number_arg(env, argv[7]), strings[6], strings[7],
  };
  fdw_dx_sampler *sampler = fdw_dx_sampler_create(owner->context, &options);
  for (int i = 0; i < 8; i++) {
    free(strings[i]);
  }
  if (!sampler) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, SAMPLER, sampler);
}

// maxColorAttachments(context): the color attachments of a render pass.
static napi_value js_max_color_attachments(napi_env env,
                                           napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  return number(env, fdw_dx_max_color_attachments(context));
}

// independentBlend(context): whether the targets can blend differently.
static napi_value js_independent_blend(napi_env env,
                                       napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_get_boolean(env, fdw_dx_independent_blend(context) != 0,
                         &result));
  return result;
}

// maxAnisotropy(context): the highest anisotropy of the samplers.
static napi_value js_max_anisotropy(napi_env env, napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  return number(env, fdw_dx_max_anisotropy(context));
}

// formatSupported(context, format): whether the device can write and
// sample textures of a format.
static napi_value js_format_supported(napi_env env, napi_callback_info info) {
  ARGS(2);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  char *format = string_arg(env, argv[1]);
  const int32_t supported = fdw_dx_format_supported(context, format);
  free(format);
  napi_value result;
  CHECK(napi_get_boolean(env, supported != 0, &result));
  return result;
}

static napi_value js_destroy_sampler(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, SAMPLER);
}

static napi_value js_sampler_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, SAMPLER);
}

// --- Properties of JavaScript objects --------------------------------------------

static napi_value property(napi_env env, napi_value object, const char *name) {
  napi_value value = NULL;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) {
    return NULL;
  }
  napi_get_named_property(env, object, name, &value);
  napi_valuetype type;
  napi_typeof(env, value, &type);
  return type == napi_undefined || type == napi_null ? NULL : value;
}

static double number_property(napi_env env, napi_value object,
                              const char *name, double fallback) {
  napi_value value = property(env, object, name);
  return value ? number_arg(env, value) : fallback;
}

static bool bool_property(napi_env env, napi_value object, const char *name) {
  napi_value value = property(env, object, name);
  bool result = false;
  if (value) {
    napi_get_value_bool(env, value, &result);
  }
  return result;
}

// The strings read for a call, freed together after it.
typedef struct strings {
  char *items[256];
  uint32_t count;
} strings;

static const char *string_property(napi_env env, napi_value object,
                                   const char *name, strings *keep) {
  napi_value value = property(env, object, name);
  char *text = value ? string_arg(env, value) : NULL;
  if (text && keep->count < 256) {
    keep->items[keep->count++] = text;
  }
  return text;
}

static void free_strings(strings *keep) {
  for (uint32_t i = 0; i < keep->count; i++) {
    free(keep->items[i]);
  }
  keep->count = 0;
}

static uint32_t array_length(napi_env env, napi_value array) {
  uint32_t length = 0;
  if (array) {
    napi_get_array_length(env, array, &length);
  }
  return length;
}

static napi_value element(napi_env env, napi_value array, uint32_t index) {
  napi_value value = NULL;
  napi_get_element(env, array, index, &value);
  return value;
}

// The object of a handle of the given kind, or NULL (null or undefined
// value); throws for a handle of another kind.
static void *optional_object(napi_env env, napi_value value, object_kind kind,
                             bool *failed) {
  napi_valuetype type;
  napi_typeof(env, value, &type);
  if (type == napi_undefined || type == napi_null) {
    return NULL;
  }
  object_handle *handle = object_arg(env, value, kind);
  if (!handle) {
    *failed = true;
    return NULL;
  }
  return handle->object;
}

// --- Shaders -----------------------------------------------------------------------

// createShader(context, hlsl, arguments: string[], label)
static napi_value js_create_shader(napi_env env, napi_callback_info info) {
  ARGS(4);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  strings keep = {{NULL}, 0};
  char *hlsl = string_arg(env, argv[1]);
  const uint32_t count = array_length(env, argv[2]);
  const char **arguments = (const char **)calloc(count + 1, sizeof(char *));
  for (uint32_t i = 0; i < count && i < 200; i++) {
    char *argument = string_arg(env, element(env, argv[2], i));
    keep.items[keep.count++] = argument;
    arguments[i] = argument;
  }
  char *label = string_arg(env, argv[3]);
  fdw_dx_shader *shader = fdw_dx_shader_create(
      owner->context, hlsl ? hlsl : "", arguments, count, label);
  free(hlsl);
  free(label);
  free(arguments);
  free_strings(&keep);
  if (!shader) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, SHADER, shader);
}

// The DXC arguments of argument `index`, kept in `keep` (count of them).
static const char **arguments_arg(napi_env env, napi_value value,
                                  strings *keep, uint32_t *count) {
  *count = array_length(env, value);
  const char **arguments = (const char **)calloc(*count + 1, sizeof(char *));
  for (uint32_t i = 0; i < *count && i < 200; i++) {
    char *argument = string_arg(env, element(env, value, i));
    keep->items[keep->count++] = argument;
    arguments[i] = argument;
  }
  return arguments;
}

// compileHlsl(hlsl, args): the SPIR-V, without a module (a Uint8Array).
static napi_value js_compile_hlsl(napi_env env, napi_callback_info info) {
  ARGS(2);
  strings keep = {{NULL}, 0};
  char *hlsl = string_arg(env, argv[0]);
  uint32_t count = 0;
  const char **arguments = arguments_arg(env, argv[1], &keep, &count);
  uint8_t *code = NULL;
  size_t size = 0;
  const int failed =
      fdw_dx_compile_hlsl(hlsl ? hlsl : "", arguments, count, &code, &size);
  free(hlsl);
  free(arguments);
  free_strings(&keep);
  if (failed) {
    return throw_last_error(env);
  }
  void *data = NULL;
  napi_value buffer, result;
  CHECK(napi_create_arraybuffer(env, size, &data, &buffer));
  memcpy(data, code, size);
  fdw_dx_free_code(code);
  CHECK(napi_create_typedarray(env, napi_uint8_array, size, buffer, 0,
                               &result));
  return result;
}

// createShaderFromCode(context, code: Uint8Array, args, label)
static napi_value js_create_shader_from_code(napi_env env,
                                             napi_callback_info info) {
  ARGS(4);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  void *code = NULL;
  size_t size = 0;
  if (bytes_arg(env, argv[1], &code, &size) != 0) {
    return NULL;
  }
  strings keep = {{NULL}, 0};
  uint32_t count = 0;
  const char **arguments = arguments_arg(env, argv[2], &keep, &count);
  char *label = string_arg(env, argv[3]);
  fdw_dx_shader *shader = fdw_dx_shader_create_from_code(
      owner->context, (const uint8_t *)code, size, arguments, count, label);
  free(label);
  free(arguments);
  free_strings(&keep);
  if (!shader) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, SHADER, shader);
}

// dxcVersion(): a string, or an error when DXC is missing.
static napi_value js_dxc_version(napi_env env, napi_callback_info info) {
  (void)info;
  const char *version = fdw_dx_dxc_version();
  if (!version) {
    return throw_last_error(env);
  }
  napi_value result;
  CHECK(napi_create_string_utf8(env, version, NAPI_AUTO_LENGTH, &result));
  return result;
}

static napi_value js_destroy_shader(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, SHADER);
}

// --- Groups ------------------------------------------------------------------------

// createGroupLayout(context, bindings: { binding, kind, stride? }[])
static napi_value js_create_group_layout(napi_env env,
                                         napi_callback_info info) {
  ARGS(2);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  const uint32_t count = array_length(env, argv[1]);
  fdw_dx_layout_binding *bindings = (fdw_dx_layout_binding *)calloc(
      count + 1, sizeof(fdw_dx_layout_binding));
  for (uint32_t i = 0; i < count; i++) {
    napi_value binding = element(env, argv[1], i);
    bindings[i].binding = (uint32_t)number_property(env, binding, "binding", 0);
    bindings[i].kind =
        (fdw_dx_binding_kind)number_property(env, binding, "kind", 0);
    bindings[i].stride = (uint32_t)number_property(env, binding, "stride", 0);
  }
  fdw_dx_group_layout *layout =
      fdw_dx_group_layout_create(owner->context, bindings, count);
  free(bindings);
  if (!layout) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, LAYOUT, layout);
}

// createGroup(context, layout, entries: { binding, object }[])
static napi_value js_create_group(napi_env env, napi_callback_info info) {
  ARGS(3);
  context_handle *owner = owner_arg(env, argv[0]);
  object_handle *layout = owner ? object_arg(env, argv[1], LAYOUT) : NULL;
  if (!layout) {
    return NULL;
  }
  const uint32_t count = array_length(env, argv[2]);
  fdw_dx_group_entry *entries =
      (fdw_dx_group_entry *)calloc(count + 1, sizeof(fdw_dx_group_entry));
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry = element(env, argv[2], i);
    entries[i].binding = (uint32_t)number_property(env, entry, "binding", 0);
    entries[i].object = (uint32_t)number_property(env, entry, "object", 0);
  }
  fdw_dx_group *group =
      fdw_dx_group_create(owner->context, layout->object, entries, count);
  free(entries);
  if (!group) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, GROUP, group);
}

static napi_value js_destroy_group(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, GROUP);
}

static napi_value js_group_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, GROUP);
}

// --- Pipelines ---------------------------------------------------------------------

static void blend_component(napi_env env, napi_value object,
                            fdw_dx_blend_component *component, strings *keep) {
  if (!object) {
    return;
  }
  component->src_factor = string_property(env, object, "srcFactor", keep);
  component->dst_factor = string_property(env, object, "dstFactor", keep);
  component->operation = string_property(env, object, "operation", keep);
}

// createRenderPipeline(context, options): see fdw_dx_render_pipeline_options.
static napi_value js_create_render_pipeline(napi_env env,
                                            napi_callback_info info) {
  ARGS(2);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  napi_value options = argv[1];
  strings keep = {{NULL}, 0};
  bool failed = false;
  fdw_dx_render_pipeline_options descriptor;
  memset(&descriptor, 0, sizeof(descriptor));

  napi_value vertex = property(env, options, "vertex");
  napi_value fragment = property(env, options, "fragment");
  descriptor.vertex =
      vertex ? (fdw_dx_shader *)optional_object(env, vertex, SHADER, &failed)
             : NULL;
  descriptor.fragment =
      fragment
          ? (fdw_dx_shader *)optional_object(env, fragment, SHADER, &failed)
          : NULL;

  napi_value groups = property(env, options, "groups");
  descriptor.group_count = array_length(env, groups);
  fdw_dx_group_layout **layouts = (fdw_dx_group_layout **)calloc(
      descriptor.group_count + 1, sizeof(fdw_dx_group_layout *));
  for (uint32_t i = 0; i < descriptor.group_count; i++) {
    layouts[i] = (fdw_dx_group_layout *)optional_object(
        env, element(env, groups, i), LAYOUT, &failed);
  }
  descriptor.groups = layouts;

  napi_value buffers = property(env, options, "vertexBuffers");
  descriptor.vertex_buffer_count = array_length(env, buffers);
  fdw_dx_vertex_buffer *vertexBuffers = (fdw_dx_vertex_buffer *)calloc(
      descriptor.vertex_buffer_count + 1, sizeof(fdw_dx_vertex_buffer));
  for (uint32_t i = 0; i < descriptor.vertex_buffer_count; i++) {
    napi_value buffer = element(env, buffers, i);
    napi_value attributes = property(env, buffer, "attributes");
    const uint32_t count = array_length(env, attributes);
    fdw_dx_vertex_attribute *list = (fdw_dx_vertex_attribute *)calloc(
        count + 1, sizeof(fdw_dx_vertex_attribute));
    for (uint32_t a = 0; a < count; a++) {
      napi_value attribute = element(env, attributes, a);
      list[a].location =
          (uint32_t)number_property(env, attribute, "location", 0);
      list[a].format = string_property(env, attribute, "format", &keep);
      list[a].offset = (uint32_t)number_property(env, attribute, "offset", 0);
    }
    vertexBuffers[i].stride =
        (uint32_t)number_property(env, buffer, "stride", 0);
    vertexBuffers[i].per_instance = bool_property(env, buffer, "perInstance");
    vertexBuffers[i].attributes = list;
    vertexBuffers[i].attribute_count = count;
  }
  descriptor.vertex_buffers = vertexBuffers;

  descriptor.topology = string_property(env, options, "topology", &keep);
  descriptor.cull_mode = string_property(env, options, "cullMode", &keep);
  descriptor.front_face = string_property(env, options, "frontFace", &keep);
  descriptor.depth_format = string_property(env, options, "depthFormat", &keep);
  descriptor.depth_write = bool_property(env, options, "depthWrite");
  descriptor.depth_compare =
      string_property(env, options, "depthCompare", &keep);
  descriptor.depth_bias =
      (float)number_property(env, options, "depthBias", 0);
  descriptor.depth_bias_slope_scale =
      (float)number_property(env, options, "depthBiasSlopeScale", 0);
  descriptor.sample_count =
      (uint32_t)number_property(env, options, "sampleCount", 1);
  descriptor.label = string_property(env, options, "label", &keep);

  napi_value targets = property(env, options, "targets");
  descriptor.target_count = array_length(env, targets);
  fdw_dx_color_target *colorTargets = (fdw_dx_color_target *)calloc(
      descriptor.target_count + 1, sizeof(fdw_dx_color_target));
  for (uint32_t i = 0; i < descriptor.target_count; i++) {
    napi_value target = element(env, targets, i);
    colorTargets[i].format = string_property(env, target, "format", &keep);
    napi_value blend = property(env, target, "blend");
    colorTargets[i].blend = blend != NULL;
    if (blend) {
      blend_component(env, property(env, blend, "color"),
                      &colorTargets[i].color, &keep);
      blend_component(env, property(env, blend, "alpha"),
                      &colorTargets[i].alpha, &keep);
    }
  }
  descriptor.targets = colorTargets;

  fdw_dx_pipeline *pipeline =
      failed ? NULL
             : fdw_dx_render_pipeline_create(owner->context, &descriptor);
  for (uint32_t i = 0; i < descriptor.vertex_buffer_count; i++) {
    free((void *)vertexBuffers[i].attributes);
  }
  free(vertexBuffers);
  free(colorTargets);
  free(layouts);
  free_strings(&keep);
  if (failed) {
    return NULL;
  }
  if (!pipeline) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, PIPELINE, pipeline);
}

// createComputePipeline(context, shader, groups: (layout | null)[], label)
static napi_value js_create_compute_pipeline(napi_env env,
                                             napi_callback_info info) {
  ARGS(4);
  context_handle *owner = owner_arg(env, argv[0]);
  object_handle *shader = owner ? object_arg(env, argv[1], SHADER) : NULL;
  if (!shader) {
    return NULL;
  }
  bool failed = false;
  const uint32_t count = array_length(env, argv[2]);
  fdw_dx_group_layout **layouts = (fdw_dx_group_layout **)calloc(
      count + 1, sizeof(fdw_dx_group_layout *));
  for (uint32_t i = 0; i < count; i++) {
    layouts[i] = (fdw_dx_group_layout *)optional_object(
        env, element(env, argv[2], i), LAYOUT, &failed);
  }
  char *label = string_arg(env, argv[3]);
  fdw_dx_pipeline *pipeline =
      failed ? NULL
             : fdw_dx_compute_pipeline_create(owner->context, shader->object,
                                              layouts, count, label);
  free(layouts);
  free(label);
  if (failed) {
    return NULL;
  }
  if (!pipeline) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, PIPELINE, pipeline);
}

static napi_value js_destroy_pipeline(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, PIPELINE);
}

static napi_value js_pipeline_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, PIPELINE);
}

// --- Swapchains --------------------------------------------------------------------

static uint64_t bigint_property(napi_env env, napi_value object,
                                const char *name) {
  napi_value value = property(env, object, name);
  uint64_t result = 0;
  bool lossless = false;
  if (value) {
    napi_get_value_bigint_uint64(env, value, &result, &lossless);
  }
  return result;
}

static const char *system_names[] = {"unknown", "x11", "wayland", "win32",
                                     "cocoa"};

// createSwapchain(context, { system, display, window }, width, height, vsync)
static napi_value js_create_swapchain(napi_env env, napi_callback_info info) {
  ARGS(5);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  strings keep = {{NULL}, 0};
  const char *system = string_property(env, argv[1], "system", &keep);
  fdw_dx_window_handle window = {0, bigint_property(env, argv[1], "display"),
                                 bigint_property(env, argv[1], "window")};
  for (int32_t i = 0; i < 5; i++) {
    if (system && strcmp(system, system_names[i]) == 0) {
      window.system = i;
    }
  }
  free_strings(&keep);
  bool vsync = true;
  napi_get_value_bool(env, argv[4], &vsync);
  fdw_dx_swapchain *swapchain = fdw_dx_swapchain_create(
      owner->context, &window, (uint32_t)number_arg(env, argv[2]),
      (uint32_t)number_arg(env, argv[3]), vsync ? 1 : 0);
  if (!swapchain) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, SWAPCHAIN, swapchain);
}

static napi_value js_destroy_swapchain(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, SWAPCHAIN);
}

static napi_value js_swapchain_format(napi_env env, napi_callback_info info) {
  ARGS(1);
  object_handle *handle = object_arg(env, argv[0], SWAPCHAIN);
  if (!handle) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_create_string_utf8(env, fdw_dx_swapchain_format(handle->object),
                                NAPI_AUTO_LENGTH, &result));
  return result;
}

// swapchainImages(swapchain): the texture handles of the images.
static napi_value js_swapchain_images(napi_env env, napi_callback_info info) {
  ARGS(1);
  object_handle *handle = object_arg(env, argv[0], SWAPCHAIN);
  if (!handle) {
    return NULL;
  }
  napi_value context;
  CHECK(napi_get_reference_value(env, handle->owner_ref, &context));
  const uint32_t count = fdw_dx_swapchain_image_count(handle->object);
  napi_value result;
  CHECK(napi_create_array_with_length(env, count, &result));
  for (uint32_t i = 0; i < count; i++) {
    napi_value image = wrap_object(env, context, handle->owner, TEXTURE,
                                   fdw_dx_swapchain_image(handle->object, i));
    if (!image) {
      return NULL;
    }
    CHECK(napi_set_element(env, result, i, image));
  }
  return result;
}

// acquireImage(swapchain, width, height): { index, recreated, width, height }
// (the size of the images).
static napi_value js_acquire_image(napi_env env, napi_callback_info info) {
  ARGS(3);
  object_handle *handle = object_arg(env, argv[0], SWAPCHAIN);
  if (!handle) {
    return NULL;
  }
  int32_t recreated = 0;
  const int index = fdw_dx_swapchain_acquire(
      handle->owner->context, handle->object,
      (uint32_t)number_arg(env, argv[1]), (uint32_t)number_arg(env, argv[2]),
      &recreated);
  if (index < 0) {
    return throw_last_error(env);
  }
  napi_value result, recreatedValue;
  CHECK(napi_create_object(env, &result));
  CHECK(napi_set_named_property(env, result, "index", number(env, index)));
  CHECK(napi_get_boolean(env, recreated != 0, &recreatedValue));
  CHECK(napi_set_named_property(env, result, "recreated", recreatedValue));
  uint32_t width = 0;
  uint32_t height = 0;
  fdw_dx_swapchain_extent(handle->object, &width, &height);
  CHECK(napi_set_named_property(env, result, "width", number(env, width)));
  CHECK(napi_set_named_property(env, result, "height", number(env, height)));
  return result;
}

static napi_value js_present(napi_env env, napi_callback_info info) {
  ARGS(1);
  object_handle *handle = object_arg(env, argv[0], SWAPCHAIN);
  if (!handle) {
    return NULL;
  }
  if (fdw_dx_swapchain_present(handle->owner->context, handle->object) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// --- Commands --------------------------------------------------------------------

// submit(context, words: Uint32Array)
static napi_value js_submit(napi_env env, napi_callback_info info) {
  ARGS(2);
  fdw_dx_context *context = context_arg(env, argv[0]);
  void *data = NULL;
  size_t length = 0;
  if (!context || bytes_arg(env, argv[1], &data, &length) != 0) {
    return NULL;
  }
  if (fdw_dx_submit(context, (const uint32_t *)data, length / 4) != 0) {
    return throw_last_error(env);
  }
  return undefined(env);
}

// --- Acceleration structures -------------------------------------------------------

// createRayTracingPipeline(context, shader, anyHit, workgroupSize: number[3],
// layouts, label)
static napi_value js_create_ray_tracing_pipeline(napi_env env,
                                                 napi_callback_info info) {
  ARGS(6);
  context_handle *owner = owner_arg(env, argv[0]);
  object_handle *shader = owner ? object_arg(env, argv[1], SHADER) : NULL;
  if (!shader) {
    return NULL;
  }
  uint32_t size[3];
  for (uint32_t k = 0; k < 3; k++) {
    size[k] = (uint32_t)number_arg(env, element(env, argv[3], k));
  }
  bool failed = false;
  const uint32_t count = array_length(env, argv[4]);
  fdw_dx_group_layout **layouts = (fdw_dx_group_layout **)calloc(
      count + 1, sizeof(fdw_dx_group_layout *));
  for (uint32_t i = 0; i < count; i++) {
    layouts[i] = (fdw_dx_group_layout *)optional_object(
        env, element(env, argv[4], i), LAYOUT, &failed);
  }
  char *label = string_arg(env, argv[5]);
  fdw_dx_pipeline *pipeline =
      failed ? NULL
             : fdw_dx_ray_tracing_pipeline_create(
                   owner->context, shader->object,
                   number_arg(env, argv[2]) != 0 ? 1u : 0u, size, layouts, count,
                   label);
  free(layouts);
  free(label);
  if (failed) {
    return NULL;
  }
  if (!pipeline) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, PIPELINE, pipeline);
}

static napi_value js_ray_tracing_pipeline_supported(napi_env env,
                                                    napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_get_boolean(
      env, fdw_dx_ray_tracing_pipeline_supported(context) == 1, &result));
  return result;
}

static napi_value js_ray_query_supported(napi_env env,
                                         napi_callback_info info) {
  ARGS(1);
  fdw_dx_context *context = context_arg(env, argv[0]);
  if (!context) {
    return NULL;
  }
  napi_value result;
  CHECK(napi_get_boolean(env, fdw_dx_ray_query_supported(context) == 1,
                         &result));
  return result;
}

// createBottomLevel(context, positions: Float32Array, indices: Uint32Array,
// flags, label)
static napi_value js_create_bottom_level(napi_env env,
                                         napi_callback_info info) {
  ARGS(5);
  context_handle *owner = owner_arg(env, argv[0]);
  void *positions = NULL;
  void *indices = NULL;
  size_t positionBytes = 0;
  size_t indexBytes = 0;
  if (!owner || bytes_arg(env, argv[1], &positions, &positionBytes) != 0 ||
      bytes_arg(env, argv[2], &indices, &indexBytes) != 0) {
    return NULL;
  }
  char *label = string_arg(env, argv[4]);
  fdw_dx_bottom_level *bottom = fdw_dx_bottom_level_create(
      owner->context, (const float *)positions,
      (uint32_t)(positionBytes / 12), (const uint32_t *)indices,
      (uint32_t)(indexBytes / 4), (uint32_t)number_arg(env, argv[3]), label);
  free(label);
  if (!bottom) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, BOTTOM_LEVEL, bottom);
}

static napi_value js_destroy_bottom_level(napi_env env,
                                          napi_callback_info info) {
  return destroy_object(env, info, BOTTOM_LEVEL);
}

static napi_value js_bottom_level_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, BOTTOM_LEVEL);
}

// createTopLevel(context, capacity, label)
static napi_value js_create_top_level(napi_env env, napi_callback_info info) {
  ARGS(3);
  context_handle *owner = owner_arg(env, argv[0]);
  if (!owner) {
    return NULL;
  }
  char *label = string_arg(env, argv[2]);
  fdw_dx_top_level *top = fdw_dx_top_level_create(
      owner->context, (uint32_t)number_arg(env, argv[1]), label);
  free(label);
  if (!top) {
    return throw_last_error(env);
  }
  return wrap_object(env, argv[0], owner, TOP_LEVEL, top);
}

// updateTopLevel(top, instances): the instances as fdw_dx_instance (14
// words each: 12 floats, 2 u32), in a typed array. Whether the structure
// was replaced.
static napi_value js_update_top_level(napi_env env, napi_callback_info info) {
  ARGS(2);
  object_handle *handle = object_arg(env, argv[0], TOP_LEVEL);
  void *data = NULL;
  size_t length = 0;
  if (!handle || bytes_arg(env, argv[1], &data, &length) != 0) {
    return NULL;
  }
  const int replaced = fdw_dx_top_level_update(
      handle->owner->context, handle->object, (const fdw_dx_instance *)data,
      (uint32_t)(length / sizeof(fdw_dx_instance)));
  if (replaced < 0) {
    return throw_last_error(env);
  }
  napi_value result;
  CHECK(napi_get_boolean(env, replaced == 1, &result));
  return result;
}

static napi_value js_destroy_top_level(napi_env env, napi_callback_info info) {
  return destroy_object(env, info, TOP_LEVEL);
}

static napi_value js_top_level_id(napi_env env, napi_callback_info info) {
  return object_id(env, info, TOP_LEVEL);
}

#define EXPORT(name, function)                                                 \
  { name, NULL, function, NULL, NULL, NULL, napi_default, NULL }

static napi_value init_module(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      EXPORT("createContext", js_create_context),
      EXPORT("destroyContext", js_destroy_context),
      EXPORT("deviceName", js_device_name),
      EXPORT("validationEnabled", js_validation_enabled),
      EXPORT("takeMessages", js_take_messages),
      EXPORT("waitIdle", js_wait_idle),
      EXPORT("flush", js_flush),
      EXPORT("createBuffer", js_create_buffer),
      EXPORT("destroyBuffer", js_destroy_buffer),
      EXPORT("writeBuffer", js_write_buffer),
      EXPORT("readBuffer", js_read_buffer),
      EXPORT("readReady", js_read_ready),
      EXPORT("readTake", js_read_take),
      EXPORT("bufferId", js_buffer_id),
      EXPORT("timestampsSupported", js_timestamps_supported),
      EXPORT("createQueryPool", js_create_query_pool),
      EXPORT("destroyQueryPool", js_destroy_query_pool),
      EXPORT("queryPoolId", js_query_pool_id),
      EXPORT("readQueryPool", js_read_query_pool),
      EXPORT("createTexture", js_create_texture),
      EXPORT("destroyTexture", js_destroy_texture),
      EXPORT("textureId", js_texture_id),
      EXPORT("writeTexture", js_write_texture),
      EXPORT("writeTextureLevel", js_write_texture_level),
      EXPORT("generateMipmaps", js_generate_mipmaps),
      EXPORT("readTexture", js_read_texture),
      EXPORT("createSampler", js_create_sampler),
      EXPORT("maxAnisotropy", js_max_anisotropy),
      EXPORT("maxColorAttachments", js_max_color_attachments),
      EXPORT("independentBlend", js_independent_blend),
      EXPORT("formatSupported", js_format_supported),
      EXPORT("destroySampler", js_destroy_sampler),
      EXPORT("samplerId", js_sampler_id),
      EXPORT("submit", js_submit),
      EXPORT("createShader", js_create_shader),
      EXPORT("destroyShader", js_destroy_shader),
      EXPORT("compileHlsl", js_compile_hlsl),
      EXPORT("createShaderFromCode", js_create_shader_from_code),
      EXPORT("dxcVersion", js_dxc_version),
      EXPORT("createGroupLayout", js_create_group_layout),
      EXPORT("createGroup", js_create_group),
      EXPORT("destroyGroup", js_destroy_group),
      EXPORT("groupId", js_group_id),
      EXPORT("createRenderPipeline", js_create_render_pipeline),
      EXPORT("createComputePipeline", js_create_compute_pipeline),
      EXPORT("rayQuerySupported", js_ray_query_supported),
      EXPORT("rayTracingPipelineSupported", js_ray_tracing_pipeline_supported),
      EXPORT("createRayTracingPipeline", js_create_ray_tracing_pipeline),
      EXPORT("createBottomLevel", js_create_bottom_level),
      EXPORT("destroyBottomLevel", js_destroy_bottom_level),
      EXPORT("bottomLevelId", js_bottom_level_id),
      EXPORT("createTopLevel", js_create_top_level),
      EXPORT("updateTopLevel", js_update_top_level),
      EXPORT("destroyTopLevel", js_destroy_top_level),
      EXPORT("topLevelId", js_top_level_id),
      EXPORT("createSwapchain", js_create_swapchain),
      EXPORT("destroySwapchain", js_destroy_swapchain),
      EXPORT("swapchainFormat", js_swapchain_format),
      EXPORT("swapchainImages", js_swapchain_images),
      EXPORT("acquireImage", js_acquire_image),
      EXPORT("present", js_present),
      EXPORT("destroyPipeline", js_destroy_pipeline),
      EXPORT("pipelineId", js_pipeline_id),
  };
  if (napi_define_properties(env, exports,
                             sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init_module)
