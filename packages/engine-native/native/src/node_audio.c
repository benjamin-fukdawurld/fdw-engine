// Node-API bindings of the audio library (include/fdw/audio.h). The engine,
// the clips and the streams are externals freed by their finalizer if the
// code did not free them; the voices and the buses are numbers. Decoding
// runs on the thread pool of libuv, never on the JavaScript thread.

#include <node_api.h>

#include <stdlib.h>
#include <string.h>

#include "fdw/audio.h"
#include "node_audio.h"

// The handles held by JavaScript; NULL once freed.
typedef struct engine_ref {
  fdw_audio *audio;
} engine_ref;

typedef struct clip_ref {
  fdw_audio_clip *clip;
} clip_ref;

typedef struct blob_ref {
  fdw_audio_blob *blob;
} blob_ref;

// Tells the kinds of externals apart.
static const napi_type_tag engine_tag = {0x6664776175646931ULL,
                                         0x656e67696e650001ULL};
static const napi_type_tag clip_tag = {0x6664776175646931ULL,
                                       0x636c697000000002ULL};
static const napi_type_tag blob_tag = {0x6664776175646931ULL,
                                       0x626c6f6200000003ULL};

static void finalize_engine(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  engine_ref *ref = (engine_ref *)data;
  fdw_audio_destroy(ref->audio);
  free(ref);
}

static void finalize_clip(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  clip_ref *ref = (clip_ref *)data;
  fdw_audio_clip_release(ref->clip);
  free(ref);
}

static void finalize_blob(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  blob_ref *ref = (blob_ref *)data;
  fdw_audio_blob_release(ref->blob);
  free(ref);
}

static napi_value make_external(napi_env env, void *ref, napi_finalize finalize,
                                const napi_type_tag *tag) {
  napi_value external;
  if (napi_create_external(env, ref, finalize, NULL, &external) != napi_ok ||
      napi_type_tag_object(env, external, tag) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot create the handle");
    return NULL;
  }
  return external;
}

static void *ref_of(napi_env env, napi_value value, const napi_type_tag *tag) {
  bool matches = false;
  void *data = NULL;
  if (napi_check_object_type_tag(env, value, tag, &matches) != napi_ok ||
      !matches || napi_get_value_external(env, value, &data) != napi_ok) {
    return NULL;
  }
  return data;
}

// The engine of the first argument, or NULL with an exception thrown.
static fdw_audio *audio_of(napi_env env, napi_value value) {
  engine_ref *ref = (engine_ref *)ref_of(env, value, &engine_tag);
  if (!ref || !ref->audio) {
    napi_throw_error(env, NULL, "The audio engine is destroyed");
    return NULL;
  }
  return ref->audio;
}

static size_t args(napi_env env, napi_callback_info info, napi_value *argv,
                   size_t count) {
  size_t argc = count;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    return 0;
  }
  return argc;
}

static double number(napi_env env, napi_value value) {
  double result = 0;
  napi_get_value_double(env, value, &result);
  return result;
}

static int integer(napi_env env, napi_value value) {
  int32_t result = 0;
  napi_get_value_int32(env, value, &result);
  return result;
}

static napi_value make_number(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

static napi_value make_boolean(napi_env env, int value) {
  napi_value result;
  napi_get_boolean(env, value != 0, &result);
  return result;
}

static napi_value make_numbers(napi_env env, const double *values,
                               uint32_t count) {
  napi_value array;
  napi_create_array_with_length(env, count, &array);
  for (uint32_t i = 0; i < count; i++) {
    napi_set_element(env, array, i, make_number(env, values[i]));
  }
  return array;
}

// The floats of a Float32Array, or NULL with an exception thrown.
static float *floats_of(napi_env env, napi_value value, size_t *count) {
  napi_typedarray_type type;
  void *data = NULL;
  napi_value buffer;
  size_t offset = 0;
  bool is_typed = false;
  napi_is_typedarray(env, value, &is_typed);
  if (!is_typed ||
      napi_get_typedarray_info(env, value, &type, count, &data, &buffer,
                               &offset) != napi_ok ||
      type != napi_float32_array) {
    napi_throw_type_error(env, NULL, "Expected a Float32Array");
    return NULL;
  }
  return (float *)data;
}

// The bytes of a typed array or an ArrayBuffer.
static int bytes_of(napi_env env, napi_value value, const void **data,
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
                                 &offset) != napi_ok ||
        (type != napi_uint8_array && type != napi_int8_array &&
         type != napi_uint8_clamped_array)) {
      return 0;
    }
    *data = base;
    *length = count;
    return 1;
  }
  bool is_buffer = false;
  napi_is_arraybuffer(env, value, &is_buffer);
  if (is_buffer) {
    void *base = NULL;
    if (napi_get_arraybuffer_info(env, value, &base, length) != napi_ok) {
      return 0;
    }
    *data = base;
    return 1;
  }
  return 0;
}

// --- The engine --------------------------------------------------------------

// audioCreate(sampleRate, channels, offline): the engine.
static napi_value js_create(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  if (args(env, info, argv, 3) < 3) {
    napi_throw_type_error(env, NULL,
                          "audioCreate(sampleRate, channels, offline)");
    return NULL;
  }
  fdw_audio_desc desc = {
      .sample_rate = (uint32_t)integer(env, argv[0]),
      .channels = (uint32_t)integer(env, argv[1]),
      .offline = integer(env, argv[2]),
  };
  engine_ref *ref = (engine_ref *)calloc(1, sizeof(engine_ref));
  const char *error = "Out of memory";
  if (ref) {
    ref->audio = fdw_audio_create(&desc, &error);
  }
  if (!ref || !ref->audio) {
    free(ref);
    napi_throw_error(env, NULL, error);
    return NULL;
  }
  return make_external(env, ref, finalize_engine, &engine_tag);
}

static napi_value js_destroy(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  engine_ref *ref = (engine_ref *)ref_of(env, argv[0], &engine_tag);
  if (ref && ref->audio) {
    fdw_audio_destroy(ref->audio);
    ref->audio = NULL;
  }
  return NULL;
}

// audioInfo(engine): [sampleRate, channels].
static napi_value js_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (!audio) {
    return NULL;
  }
  const double values[2] = {fdw_audio_sample_rate(audio),
                            fdw_audio_channels(audio)};
  return make_numbers(env, values, 2);
}

static napi_value js_time(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_number(env, fdw_audio_time(audio)) : NULL;
}

static napi_value js_set_running(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_boolean(
                     env, fdw_audio_set_running(audio, integer(env, argv[1])))
               : NULL;
}

// audioRender(engine, out): mixes out.length / channels frames into out.
static napi_value js_render(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  size_t count = 0;
  float *out = audio ? floats_of(env, argv[1], &count) : NULL;
  if (!out) {
    return NULL;
  }
  const uint64_t frames = count / fdw_audio_channels(audio);
  return make_number(env, (double)fdw_audio_render(audio, out, frames));
}

static napi_value js_bus_create(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_number(env,
                             fdw_audio_bus_create(audio, integer(env, argv[1])))
               : NULL;
}

static napi_value js_bus_volume(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  args(env, info, argv, 3);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_bus_set_volume(audio, integer(env, argv[1]),
                             (float)number(env, argv[2]));
  }
  return NULL;
}

// audioListener(engine, pose): pose = position, forward, up (9 floats).
static napi_value js_listener(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  size_t count = 0;
  float *pose = audio ? floats_of(env, argv[1], &count) : NULL;
  if (!pose) {
    return NULL;
  }
  if (count < 9) {
    napi_throw_range_error(env, NULL, "The pose has 9 floats");
    return NULL;
  }
  fdw_audio_listener(audio, pose, pose + 3, pose + 6);
  return NULL;
}

// --- Clips and streams -------------------------------------------------------

// audioClipCreate(samples, channels, sampleRate): a clip of interleaved
// samples, copied.
static napi_value js_clip_create(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  if (args(env, info, argv, 3) < 3) {
    napi_throw_type_error(env, NULL,
                          "audioClipCreate(samples, channels, sampleRate)");
    return NULL;
  }
  size_t count = 0;
  const float *samples = floats_of(env, argv[0], &count);
  if (!samples) {
    return NULL;
  }
  const int channels = integer(env, argv[1]);
  const int rate = integer(env, argv[2]);
  if (channels <= 0 || rate <= 0) {
    napi_throw_range_error(env, NULL, "Invalid channels or sample rate");
    return NULL;
  }
  clip_ref *ref = (clip_ref *)calloc(1, sizeof(clip_ref));
  if (ref) {
    ref->clip = fdw_audio_clip_create(samples, count / (size_t)channels,
                                      (uint32_t)channels, (uint32_t)rate);
  }
  if (!ref || !ref->clip) {
    free(ref);
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  return make_external(env, ref, finalize_clip, &clip_tag);
}

typedef struct decode_job {
  napi_async_work work;
  napi_deferred deferred;
  // Keeps the input alive while the pool reads it.
  napi_ref input;
  const void *bytes;
  size_t length;
  // A clip (decoded), or a blob (checked, kept encoded).
  int stream;
  fdw_audio_clip *clip;
  fdw_audio_blob *blob;
  const char *error;
} decode_job;

static void execute_decode(napi_env env, void *data) {
  (void)env;
  decode_job *job = (decode_job *)data;
  if (job->stream) {
    job->blob = fdw_audio_blob_create(job->bytes, job->length, &job->error);
  } else {
    job->clip = fdw_audio_clip_decode(job->bytes, job->length, &job->error);
  }
}

static void complete_decode(napi_env env, napi_status status, void *data) {
  decode_job *job = (decode_job *)data;
  napi_value result = NULL;
  const char *error =
      status == napi_cancelled ? "The decoding was cancelled" : job->error;
  if (!error) {
    if (job->stream) {
      blob_ref *ref = (blob_ref *)calloc(1, sizeof(blob_ref));
      if (ref) {
        ref->blob = job->blob;
        job->blob = NULL;
        result = make_external(env, ref, finalize_blob, &blob_tag);
      }
    } else {
      clip_ref *ref = (clip_ref *)calloc(1, sizeof(clip_ref));
      if (ref) {
        ref->clip = job->clip;
        job->clip = NULL;
        result = make_external(env, ref, finalize_clip, &clip_tag);
      }
    }
    if (!result) {
      error = "Out of memory";
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
  fdw_audio_clip_release(job->clip);
  fdw_audio_blob_release(job->blob);
  napi_delete_reference(env, job->input);
  napi_delete_async_work(env, job->work);
  free(job);
}

static napi_value start_decode(napi_env env, napi_callback_info info,
                               int stream) {
  napi_value argv[1];
  if (args(env, info, argv, 1) < 1) {
    napi_throw_type_error(env, NULL, "Expected the bytes of the file");
    return NULL;
  }
  decode_job *job = (decode_job *)calloc(1, sizeof(decode_job));
  if (!job) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  job->stream = stream;
  if (!bytes_of(env, argv[0], &job->bytes, &job->length)) {
    free(job);
    napi_throw_type_error(env, NULL, "Expected a Uint8Array");
    return NULL;
  }
  napi_value promise;
  napi_value name;
  if (napi_create_reference(env, argv[0], 1, &job->input) != napi_ok ||
      napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "fdw:decodeAudio", NAPI_AUTO_LENGTH,
                              &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, execute_decode, complete_decode,
                             job, &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    napi_throw_error(env, NULL, "Cannot start the decoding");
    return NULL;
  }
  return promise;
}

// audioDecode(bytes): a promise of a clip, decoded on the thread pool.
static napi_value js_decode(napi_env env, napi_callback_info info) {
  return start_decode(env, info, 0);
}

// audioStreamCreate(bytes): a promise of a stream, the bytes copied and
// checked on the thread pool.
static napi_value js_stream_create(napi_env env, napi_callback_info info) {
  return start_decode(env, info, 1);
}

// audioClipInfo(clip): [frames, channels, sampleRate].
static napi_value js_clip_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  clip_ref *ref = (clip_ref *)ref_of(env, argv[0], &clip_tag);
  if (!ref || !ref->clip) {
    napi_throw_error(env, NULL, "The clip is disposed");
    return NULL;
  }
  uint64_t frames;
  uint32_t channels;
  uint32_t rate;
  fdw_audio_clip_info(ref->clip, &frames, &channels, &rate);
  const double values[3] = {(double)frames, channels, rate};
  return make_numbers(env, values, 3);
}

// audioClipSamples(clip): a copy of its interleaved samples.
static napi_value js_clip_samples(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  clip_ref *ref = (clip_ref *)ref_of(env, argv[0], &clip_tag);
  if (!ref || !ref->clip) {
    napi_throw_error(env, NULL, "The clip is disposed");
    return NULL;
  }
  uint64_t frames;
  uint32_t channels;
  uint32_t rate;
  fdw_audio_clip_info(ref->clip, &frames, &channels, &rate);
  const size_t count = (size_t)(frames * channels);
  napi_value buffer;
  void *data = NULL;
  napi_value array;
  if (napi_create_arraybuffer(env, count * sizeof(float), &data, &buffer) !=
          napi_ok ||
      napi_create_typedarray(env, napi_float32_array, count, buffer, 0,
                             &array) != napi_ok) {
    napi_throw_error(env, NULL, "Out of memory");
    return NULL;
  }
  memcpy(data, fdw_audio_clip_samples(ref->clip), count * sizeof(float));
  return array;
}

static napi_value js_clip_release(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  clip_ref *ref = (clip_ref *)ref_of(env, argv[0], &clip_tag);
  if (ref && ref->clip) {
    fdw_audio_clip_release(ref->clip);
    ref->clip = NULL;
  }
  return NULL;
}

// audioStreamInfo(stream): [duration (-1: unknown), channels, sampleRate,
// bytes].
static napi_value js_stream_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  blob_ref *ref = (blob_ref *)ref_of(env, argv[0], &blob_tag);
  if (!ref || !ref->blob) {
    napi_throw_error(env, NULL, "The stream is disposed");
    return NULL;
  }
  double duration;
  uint32_t channels;
  uint32_t rate;
  fdw_audio_blob_info(ref->blob, &duration, &channels, &rate);
  const double values[4] = {duration, channels, rate,
                            (double)fdw_audio_blob_size(ref->blob)};
  return make_numbers(env, values, 4);
}

static napi_value js_stream_release(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  blob_ref *ref = (blob_ref *)ref_of(env, argv[0], &blob_tag);
  if (ref && ref->blob) {
    fdw_audio_blob_release(ref->blob);
    ref->blob = NULL;
  }
  return NULL;
}

// --- Voices ------------------------------------------------------------------

// audioPlay(engine, source, bus, params): the id of the voice, or -1. The
// params (a Float32Array): volume, pitch, pan, loop, offset, fadeIn, paused,
// spatial, x, y, z, refDistance, maxDistance, rolloff, distanceModel.
static napi_value js_play(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  if (args(env, info, argv, 4) < 4) {
    napi_throw_type_error(env, NULL, "audioPlay(engine, source, bus, params)");
    return NULL;
  }
  fdw_audio *audio = audio_of(env, argv[0]);
  if (!audio) {
    return NULL;
  }
  fdw_audio_play_desc desc;
  memset(&desc, 0, sizeof(desc));
  clip_ref *clip = (clip_ref *)ref_of(env, argv[1], &clip_tag);
  blob_ref *blob = clip ? NULL : (blob_ref *)ref_of(env, argv[1], &blob_tag);
  desc.clip = clip ? clip->clip : NULL;
  desc.blob = blob ? blob->blob : NULL;
  if (!desc.clip && !desc.blob) {
    napi_throw_error(env, NULL, "The sound is disposed");
    return NULL;
  }
  size_t count = 0;
  const float *p = floats_of(env, argv[3], &count);
  if (!p) {
    return NULL;
  }
  if (count < 15) {
    napi_throw_range_error(env, NULL, "audioPlay takes 15 parameters");
    return NULL;
  }
  desc.bus = integer(env, argv[2]);
  desc.volume = p[0];
  desc.pitch = p[1];
  desc.pan = p[2];
  desc.loop = p[3] != 0;
  desc.offset = p[4];
  desc.fade_in = p[5];
  desc.paused = p[6] != 0;
  desc.spatial = p[7] != 0;
  desc.position[0] = p[8];
  desc.position[1] = p[9];
  desc.position[2] = p[10];
  desc.ref_distance = p[11];
  desc.max_distance = p[12];
  desc.rolloff = p[13];
  desc.distance_model = (fdw_audio_distance_model)(int)p[14];
  return make_number(env, fdw_audio_play(audio, &desc));
}

// audioVoiceSet(engine, voice, param, value): 0 volume, 1 pitch, 2 pan,
// 3 loop.
static napi_value js_voice_set(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  args(env, info, argv, 4);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_voice_set(audio, integer(env, argv[1]),
                        (fdw_audio_param)integer(env, argv[2]),
                        (float)number(env, argv[3]));
  }
  return NULL;
}

static napi_value js_voice_position(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  args(env, info, argv, 5);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_voice_position(
        audio, integer(env, argv[1]), (float)number(env, argv[2]),
        (float)number(env, argv[3]), (float)number(env, argv[4]));
  }
  return NULL;
}

static napi_value js_voice_fade(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  args(env, info, argv, 4);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_voice_fade(audio, integer(env, argv[1]),
                         (float)number(env, argv[2]),
                         (float)number(env, argv[3]));
  }
  return NULL;
}

static napi_value js_voice_pause(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  args(env, info, argv, 3);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_voice_pause(audio, integer(env, argv[1]), integer(env, argv[2]));
  }
  return NULL;
}

static napi_value js_voice_stop(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  args(env, info, argv, 3);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (audio) {
    fdw_audio_voice_stop(audio, integer(env, argv[1]),
                         (float)number(env, argv[2]));
  }
  return NULL;
}

static napi_value js_voice_time(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_number(env,
                             fdw_audio_voice_time(audio, integer(env, argv[1])))
               : NULL;
}

// audioVoiceState(engine, voice): 0 stopped, 1 playing, 2 paused.
static napi_value js_voice_state(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_number(env, fdw_audio_voice_state_of(
                                      audio, integer(env, argv[1])))
               : NULL;
}

// audioUpdate(engine, ended): frees the voices that have ended, writes their
// ids into ended (an Int32Array), returns how many.
static napi_value js_update(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  args(env, info, argv, 2);
  fdw_audio *audio = audio_of(env, argv[0]);
  if (!audio) {
    return NULL;
  }
  napi_typedarray_type type;
  size_t count = 0;
  void *data = NULL;
  napi_value buffer;
  size_t offset = 0;
  bool is_typed = false;
  napi_is_typedarray(env, argv[1], &is_typed);
  if (!is_typed ||
      napi_get_typedarray_info(env, argv[1], &type, &count, &data, &buffer,
                               &offset) != napi_ok ||
      type != napi_int32_array) {
    napi_throw_type_error(env, NULL, "Expected an Int32Array");
    return NULL;
  }
  return make_number(env, fdw_audio_update(audio, (int *)data, (int)count));
}

static napi_value js_voice_count(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  args(env, info, argv, 1);
  fdw_audio *audio = audio_of(env, argv[0]);
  return audio ? make_number(env, fdw_audio_voice_count(audio)) : NULL;
}

#define METHOD(name, function)                                                 \
  {name, NULL, function, NULL, NULL, NULL, napi_default, NULL}

napi_status fdw_register_audio(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      METHOD("audioCreate", js_create),
      METHOD("audioDestroy", js_destroy),
      METHOD("audioInfo", js_info),
      METHOD("audioTime", js_time),
      METHOD("audioSetRunning", js_set_running),
      METHOD("audioRender", js_render),
      METHOD("audioBusCreate", js_bus_create),
      METHOD("audioBusVolume", js_bus_volume),
      METHOD("audioListener", js_listener),
      METHOD("audioClipCreate", js_clip_create),
      METHOD("audioDecode", js_decode),
      METHOD("audioClipInfo", js_clip_info),
      METHOD("audioClipSamples", js_clip_samples),
      METHOD("audioClipRelease", js_clip_release),
      METHOD("audioStreamCreate", js_stream_create),
      METHOD("audioStreamInfo", js_stream_info),
      METHOD("audioStreamRelease", js_stream_release),
      METHOD("audioPlay", js_play),
      METHOD("audioVoiceSet", js_voice_set),
      METHOD("audioVoicePosition", js_voice_position),
      METHOD("audioVoiceFade", js_voice_fade),
      METHOD("audioVoicePause", js_voice_pause),
      METHOD("audioVoiceStop", js_voice_stop),
      METHOD("audioVoiceTime", js_voice_time),
      METHOD("audioVoiceState", js_voice_state),
      METHOD("audioUpdate", js_update),
      METHOD("audioVoiceCount", js_voice_count),
  };
  return napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
}
