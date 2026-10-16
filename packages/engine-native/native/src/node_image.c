// Node-API bindings of the image decoder (stb_image): decoded on the thread
// pool of libuv, never on the JavaScript thread.

#include <node_api.h>

#include <stdlib.h>
#include <string.h>

#include "node_image.h"
#include "stb_image.h"

typedef struct decode_job {
  napi_async_work work;
  napi_deferred deferred;
  // Keeps the input alive while the pool reads it.
  napi_ref input;
  const unsigned char *bytes;
  size_t length;
  // The result: 4 channels, unsigned bytes or floats (HDR).
  void *pixels;
  int width;
  int height;
  int channels;
  int hdr;
  const char *error;
} decode_job;

// Reads the bytes of a Uint8Array (or any typed array, or an ArrayBuffer).
static int bytes_of(napi_env env, napi_value value, const unsigned char **data,
                    size_t *length) {
  bool is_typed = false;
  napi_is_typedarray(env, value, &is_typed);
  if (is_typed) {
    napi_typedarray_type type;
    size_t count = 0;
    void *base = NULL;
    napi_value buffer;
    size_t offset = 0;
    if (napi_get_typedarray_info(env, value, &type, &count, &base, &buffer,
                                 &offset) != napi_ok) {
      return 0;
    }
    size_t element = 1;
    switch (type) {
    case napi_int16_array:
    case napi_uint16_array:
      element = 2;
      break;
    case napi_int32_array:
    case napi_uint32_array:
    case napi_float32_array:
      element = 4;
      break;
    case napi_float64_array:
    case napi_bigint64_array:
    case napi_biguint64_array:
      element = 8;
      break;
    default:
      break;
    }
    *data = (const unsigned char *)base;
    *length = count * element;
    return 1;
  }
  bool is_buffer = false;
  napi_is_arraybuffer(env, value, &is_buffer);
  if (is_buffer) {
    void *base = NULL;
    if (napi_get_arraybuffer_info(env, value, &base, length) != napi_ok) {
      return 0;
    }
    *data = (const unsigned char *)base;
    return 1;
  }
  return 0;
}

static void execute_decode(napi_env env, void *data) {
  (void)env;
  decode_job *job = (decode_job *)data;
  if (job->length > 0x7fffffff) {
    job->error = "The image is too large";
    return;
  }
  const int length = (int)job->length;
  job->hdr = stbi_is_hdr_from_memory(job->bytes, length);
  if (job->hdr) {
    job->pixels = stbi_loadf_from_memory(job->bytes, length, &job->width,
                                         &job->height, &job->channels, 4);
  } else {
    job->pixels = stbi_load_from_memory(job->bytes, length, &job->width,
                                        &job->height, &job->channels, 4);
  }
  if (!job->pixels) {
    job->error = stbi_failure_reason();
  }
}

static void free_pixels(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  stbi_image_free(data);
}

// The pixels as an ArrayBuffer: the memory of stb_image itself where the
// runtime allows external buffers, else a copy.
static napi_status pixels_buffer(napi_env env, decode_job *job,
                                 napi_value *result) {
  const size_t bytes = (size_t)job->width * (size_t)job->height * 4 *
                       (job->hdr ? sizeof(float) : 1);
  napi_status status = napi_create_external_arraybuffer(
      env, job->pixels, bytes, free_pixels, NULL, result);
  if (status == napi_ok) {
    job->pixels = NULL; // owned by the buffer now
    return napi_ok;
  }
  void *copy = NULL;
  status = napi_create_arraybuffer(env, bytes, &copy, result);
  if (status == napi_ok) {
    memcpy(copy, job->pixels, bytes);
  }
  return status;
}

static void set_number(napi_env env, napi_value object, const char *name,
                       double value) {
  napi_value number;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, name, number);
}

static void complete_decode(napi_env env, napi_status status, void *data) {
  decode_job *job = (decode_job *)data;
  napi_value result = NULL;
  const char *error = status == napi_cancelled ? "The decoding was cancelled"
                                               : job->error;
  if (!error) {
    napi_value buffer;
    napi_value array;
    if (pixels_buffer(env, job, &buffer) != napi_ok ||
        napi_create_typedarray(env,
                               job->hdr ? napi_float32_array
                                        : napi_uint8_array,
                               (size_t)job->width * (size_t)job->height * 4,
                               buffer, 0, &array) != napi_ok ||
        napi_create_object(env, &result) != napi_ok) {
      error = "Cannot create the decoded image";
    } else {
      set_number(env, result, "width", job->width);
      set_number(env, result, "height", job->height);
      // The channels of the file; the pixels always have 4.
      set_number(env, result, "channels", job->channels);
      napi_value hdr;
      napi_get_boolean(env, job->hdr != 0, &hdr);
      napi_set_named_property(env, result, "hdr", hdr);
      napi_set_named_property(env, result, "pixels", array);
    }
  }
  if (error) {
    napi_value message;
    napi_create_string_utf8(env, error, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &result);
    napi_reject_deferred(env, job->deferred, result);
  } else {
    napi_resolve_deferred(env, job->deferred, result);
  }
  if (job->pixels) {
    stbi_image_free(job->pixels);
  }
  napi_delete_reference(env, job->input);
  napi_delete_async_work(env, job->work);
  free(job);
}

// decodeImage(bytes): a promise of { width, height, channels, hdr, pixels },
// the pixels in RGBA, a Uint8Array, or a Float32Array for HDR images.
static napi_value js_decode_image(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc < 1) {
    napi_throw_type_error(env, NULL, "decodeImage(bytes) needs the bytes");
    return NULL;
  }
  decode_job *job = (decode_job *)calloc(1, sizeof(decode_job));
  if (!job) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  if (!bytes_of(env, argv[0], &job->bytes, &job->length)) {
    free(job);
    napi_throw_type_error(env, NULL, "decodeImage expects a Uint8Array");
    return NULL;
  }
  napi_value promise;
  napi_value name;
  if (napi_create_reference(env, argv[0], 1, &job->input) != napi_ok ||
      napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "fdw:decodeImage", NAPI_AUTO_LENGTH,
                              &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute_decode, complete_decode,
                             job, &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot start the decoding");
    return NULL;
  }
  return promise;
}

napi_status fdw_register_image(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"decodeImage", NULL, js_decode_image, NULL, NULL, NULL, napi_default,
       NULL},
  };
  return napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
