// The audio of the engine over miniaudio (include/fdw/audio.h): an ma_engine,
// its sound groups as buses, a ma_sound per voice reading a clip (decoded
// samples, shared) or a blob (encoded bytes, a decoder per voice).

#include "fdw/audio.h"

#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define STB_VORBIS_HEADER_ONLY
#include "stb_vorbis.c"

#include "miniaudio.h"

struct fdw_audio_clip {
  int refs;
  uint64_t frames;
  uint32_t channels;
  uint32_t sample_rate;
  float *samples;
};

struct fdw_audio_blob {
  int refs;
  size_t size;
  void *bytes;
  double duration;
  uint32_t channels;
  uint32_t sample_rate;
};

typedef struct voice {
  ma_sound sound;
  // The source of the sound: a view on the samples of a clip, or a decoder
  // of a blob.
  ma_audio_buffer_ref buffer;
  ma_decoder decoder;
  fdw_audio_clip *clip;
  fdw_audio_blob *blob;
  int paused;
} voice;

// The ids of the voices: a slot and a generation, so that the id of an
// ended voice never reaches the next one of its slot.
#define SLOT_BITS 16
#define SLOT_MASK ((1 << SLOT_BITS) - 1)
#define MAX_VOICES SLOT_MASK
#define MAX_BUSES 256

struct fdw_audio {
  ma_engine engine;
  // 0 is the master; a bus is under one created before it.
  ma_sound_group *buses[MAX_BUSES];
  int bus_count;
  voice **voices;
  int *generations;
  int capacity;
  int count;
};

static const char *result_text(ma_result result) {
  return ma_result_description(result);
}

fdw_audio *fdw_audio_create(const fdw_audio_desc *desc, const char **error) {
  fdw_audio *audio = (fdw_audio *)calloc(1, sizeof(fdw_audio));
  if (!audio) {
    *error = "Out of memory";
    return NULL;
  }
  ma_engine_config config = ma_engine_config_init();
  config.noDevice = desc->offline ? MA_TRUE : MA_FALSE;
  config.channels = desc->channels ? desc->channels : (desc->offline ? 2 : 0);
  config.sampleRate =
      desc->sample_rate ? desc->sample_rate : (desc->offline ? 48000 : 0);
  config.listenerCount = 1;
  ma_result result = ma_engine_init(&config, &audio->engine);
  if (result != MA_SUCCESS) {
    *error = result_text(result);
    free(audio);
    return NULL;
  }
  if (fdw_audio_bus_create(audio, -1) != 0) {
    *error = "Cannot create the master bus";
    ma_engine_uninit(&audio->engine);
    free(audio);
    return NULL;
  }
  return audio;
}

static void free_voice(voice *v) {
  ma_sound_uninit(&v->sound);
  if (v->clip) {
    ma_audio_buffer_ref_uninit(&v->buffer);
    fdw_audio_clip_release(v->clip);
  } else {
    ma_decoder_uninit(&v->decoder);
    fdw_audio_blob_release(v->blob);
  }
  free(v);
}

void fdw_audio_destroy(fdw_audio *audio) {
  if (!audio) {
    return;
  }
  for (int i = 0; i < audio->capacity; i++) {
    if (audio->voices[i]) {
      free_voice(audio->voices[i]);
    }
  }
  // The children before their parents.
  for (int i = audio->bus_count - 1; i >= 0; i--) {
    ma_sound_group_uninit(audio->buses[i]);
    free(audio->buses[i]);
  }
  ma_engine_uninit(&audio->engine);
  free(audio->voices);
  free(audio->generations);
  free(audio);
}

uint32_t fdw_audio_sample_rate(const fdw_audio *audio) {
  return ma_engine_get_sample_rate(&audio->engine);
}

uint32_t fdw_audio_channels(const fdw_audio *audio) {
  return ma_engine_get_channels(&audio->engine);
}

double fdw_audio_time(const fdw_audio *audio) {
  return (double)ma_engine_get_time_in_pcm_frames(&audio->engine) /
         (double)fdw_audio_sample_rate(audio);
}

int fdw_audio_set_running(fdw_audio *audio, int running) {
  if (!ma_engine_get_device(&audio->engine)) {
    return 1;
  }
  return (running ? ma_engine_start(&audio->engine)
                  : ma_engine_stop(&audio->engine)) == MA_SUCCESS;
}

uint64_t fdw_audio_render(fdw_audio *audio, float *out, uint64_t frames) {
  ma_uint64 read = 0;
  ma_engine_read_pcm_frames(&audio->engine, out, frames, &read);
  return read;
}

// parent -1: the master, under the endpoint of the engine.
int fdw_audio_bus_create(fdw_audio *audio, int parent) {
  if (audio->bus_count >= MAX_BUSES || parent >= audio->bus_count) {
    return -1;
  }
  ma_sound_group *group = (ma_sound_group *)calloc(1, sizeof(ma_sound_group));
  if (!group || ma_sound_group_init(&audio->engine, 0,
                                    parent < 0 ? NULL : audio->buses[parent],
                                    group) != MA_SUCCESS) {
    free(group);
    return -1;
  }
  // Mixed as they are: the voices are spatialized, not the buses.
  ma_sound_group_set_spatialization_enabled(group, MA_FALSE);
  audio->buses[audio->bus_count] = group;
  return audio->bus_count++;
}

void fdw_audio_bus_set_volume(fdw_audio *audio, int bus, float volume) {
  if (bus >= 0 && bus < audio->bus_count) {
    ma_sound_group_set_volume(audio->buses[bus], volume);
  }
}

void fdw_audio_listener(fdw_audio *audio, const float position[3],
                        const float forward[3], const float up[3]) {
  ma_engine_listener_set_position(&audio->engine, 0, position[0], position[1],
                                  position[2]);
  ma_engine_listener_set_direction(&audio->engine, 0, forward[0], forward[1],
                                   forward[2]);
  ma_engine_listener_set_world_up(&audio->engine, 0, up[0], up[1], up[2]);
}

// --- Clips -------------------------------------------------------------------

static fdw_audio_clip *new_clip(float *samples, uint64_t frames,
                                uint32_t channels, uint32_t sample_rate) {
  fdw_audio_clip *clip = (fdw_audio_clip *)calloc(1, sizeof(fdw_audio_clip));
  if (!clip) {
    return NULL;
  }
  clip->refs = 1;
  clip->samples = samples;
  clip->frames = frames;
  clip->channels = channels;
  clip->sample_rate = sample_rate;
  return clip;
}

fdw_audio_clip *fdw_audio_clip_create(const float *samples, uint64_t frames,
                                      uint32_t channels, uint32_t sample_rate) {
  if (channels == 0 || sample_rate == 0) {
    return NULL;
  }
  const size_t size = (size_t)(frames * channels * sizeof(float));
  // One frame at least: an empty clip still has samples.
  float *copy = (float *)malloc(size ? size : sizeof(float) * channels);
  if (!copy) {
    return NULL;
  }
  memcpy(copy, samples, size);
  fdw_audio_clip *clip = new_clip(copy, frames, channels, sample_rate);
  if (!clip) {
    free(copy);
  }
  return clip;
}

fdw_audio_clip *fdw_audio_clip_decode(const void *bytes, size_t length,
                                      const char **error) {
  ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 0, 0);
  ma_decoder decoder;
  ma_result result = ma_decoder_init_memory(bytes, length, &config, &decoder);
  if (result != MA_SUCCESS) {
    *error = "Unknown or invalid audio format (WAV, FLAC, MP3, Ogg Vorbis)";
    return NULL;
  }
  const uint32_t channels = decoder.outputChannels;
  const uint32_t sample_rate = decoder.outputSampleRate;
  // The length of a Vorbis stream is not known: read until the end.
  ma_uint64 capacity = 0;
  ma_decoder_get_length_in_pcm_frames(&decoder, &capacity);
  if (capacity == 0) {
    capacity = sample_rate;
  }
  ma_uint64 frames = 0;
  float *samples =
      (float *)malloc((size_t)(capacity * channels * sizeof(float)));
  while (samples) {
    if (frames == capacity) {
      capacity *= 2;
      float *grown = (float *)realloc(
          samples, (size_t)(capacity * channels * sizeof(float)));
      if (!grown) {
        free(samples);
        samples = NULL;
        break;
      }
      samples = grown;
    }
    ma_uint64 read = 0;
    result = ma_decoder_read_pcm_frames(&decoder, samples + frames * channels,
                                        capacity - frames, &read);
    frames += read;
    if (result != MA_SUCCESS || read == 0) {
      break;
    }
  }
  ma_decoder_uninit(&decoder);
  if (!samples) {
    *error = "Out of memory";
    return NULL;
  }
  if (frames == 0) {
    free(samples);
    *error = "The audio file has no samples";
    return NULL;
  }
  fdw_audio_clip *clip = new_clip(samples, frames, channels, sample_rate);
  if (!clip) {
    free(samples);
    *error = "Out of memory";
  }
  return clip;
}

void fdw_audio_clip_info(const fdw_audio_clip *clip, uint64_t *frames,
                         uint32_t *channels, uint32_t *sample_rate) {
  *frames = clip->frames;
  *channels = clip->channels;
  *sample_rate = clip->sample_rate;
}

const float *fdw_audio_clip_samples(const fdw_audio_clip *clip) {
  return clip->samples;
}

void fdw_audio_clip_release(fdw_audio_clip *clip) {
  if (clip && --clip->refs == 0) {
    free(clip->samples);
    free(clip);
  }
}

// --- Blobs -------------------------------------------------------------------

fdw_audio_blob *fdw_audio_blob_create(const void *bytes, size_t length,
                                      const char **error) {
  ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 0, 0);
  ma_decoder decoder;
  if (ma_decoder_init_memory(bytes, length, &config, &decoder) != MA_SUCCESS) {
    *error = "Unknown or invalid audio format (WAV, FLAC, MP3, Ogg Vorbis)";
    return NULL;
  }
  fdw_audio_blob *blob = (fdw_audio_blob *)calloc(1, sizeof(fdw_audio_blob));
  void *copy = malloc(length ? length : 1);
  if (!blob || !copy) {
    ma_decoder_uninit(&decoder);
    free(blob);
    free(copy);
    *error = "Out of memory";
    return NULL;
  }
  memcpy(copy, bytes, length);
  blob->refs = 1;
  blob->bytes = copy;
  blob->size = length;
  blob->channels = decoder.outputChannels;
  blob->sample_rate = decoder.outputSampleRate;
  blob->duration = -1;
  ma_uint64 frames = 0;
  if (length >= 4 && memcmp(bytes, "OggS", 4) == 0) {
    // miniaudio reads Vorbis in push mode, without its length: stb_vorbis
    // gives it from the whole stream.
    int failure = 0;
    stb_vorbis *vorbis = stb_vorbis_open_memory((const unsigned char *)bytes,
                                                (int)length, &failure, NULL);
    if (vorbis) {
      blob->duration = stb_vorbis_stream_length_in_seconds(vorbis);
      stb_vorbis_close(vorbis);
    }
  } else if (ma_decoder_get_length_in_pcm_frames(&decoder, &frames) ==
                 MA_SUCCESS &&
             frames > 0) {
    blob->duration = (double)frames / (double)blob->sample_rate;
  }
  ma_decoder_uninit(&decoder);
  return blob;
}

void fdw_audio_blob_info(const fdw_audio_blob *blob, double *duration,
                         uint32_t *channels, uint32_t *sample_rate) {
  *duration = blob->duration;
  *channels = blob->channels;
  *sample_rate = blob->sample_rate;
}

size_t fdw_audio_blob_size(const fdw_audio_blob *blob) { return blob->size; }

void fdw_audio_blob_release(fdw_audio_blob *blob) {
  if (blob && --blob->refs == 0) {
    free(blob->bytes);
    free(blob);
  }
}

// --- Voices ------------------------------------------------------------------

static voice *voice_of(fdw_audio *audio, int id) {
  const int slot = (id & SLOT_MASK) - 1;
  if (id <= 0 || slot < 0 || slot >= audio->capacity ||
      audio->generations[slot] != (id >> SLOT_BITS)) {
    return NULL;
  }
  return audio->voices[slot];
}

// A free slot, the arrays grown if needed; -1 when full.
static int free_slot(fdw_audio *audio) {
  for (int i = 0; i < audio->capacity; i++) {
    if (!audio->voices[i]) {
      return i;
    }
  }
  if (audio->capacity >= MAX_VOICES) {
    return -1;
  }
  int capacity = audio->capacity ? audio->capacity * 2 : 64;
  if (capacity > MAX_VOICES) {
    capacity = MAX_VOICES;
  }
  voice **voices =
      (voice **)realloc(audio->voices, (size_t)capacity * sizeof(voice *));
  if (!voices) {
    return -1;
  }
  audio->voices = voices;
  int *generations =
      (int *)realloc(audio->generations, (size_t)capacity * sizeof(int));
  if (!generations) {
    return -1;
  }
  audio->generations = generations;
  for (int i = audio->capacity; i < capacity; i++) {
    voices[i] = NULL;
    generations[i] = 0;
  }
  const int slot = audio->capacity;
  audio->capacity = capacity;
  return slot;
}

static ma_uint64 frames_of(fdw_audio *audio, float seconds) {
  return seconds > 0 ? (ma_uint64)(seconds * fdw_audio_sample_rate(audio)) : 0;
}

static void set_spatial(ma_sound *sound, const fdw_audio_play_desc *desc) {
  ma_sound_set_position(sound, desc->position[0], desc->position[1],
                        desc->position[2]);
  ma_sound_set_min_distance(sound, desc->ref_distance);
  ma_sound_set_rolloff(sound, desc->rolloff);
  ma_attenuation_model model = ma_attenuation_model_inverse;
  // As in WebAudio: only the linear model stops at the maximum distance.
  float max_distance = FLT_MAX;
  if (desc->distance_model == FDW_AUDIO_DISTANCE_LINEAR) {
    model = ma_attenuation_model_linear;
    max_distance = desc->max_distance;
  } else if (desc->distance_model == FDW_AUDIO_DISTANCE_EXPONENTIAL) {
    model = ma_attenuation_model_exponential;
  }
  ma_sound_set_attenuation_model(sound, model);
  ma_sound_set_max_distance(sound, max_distance);
  // No Doppler effect, as in WebAudio.
  ma_sound_set_doppler_factor(sound, 0);
}

int fdw_audio_play(fdw_audio *audio, const fdw_audio_play_desc *desc) {
  if ((!desc->clip == !desc->blob) || desc->bus < 0 ||
      desc->bus >= audio->bus_count) {
    return -1;
  }
  const int slot = free_slot(audio);
  if (slot < 0) {
    return -1;
  }
  voice *v = (voice *)calloc(1, sizeof(voice));
  if (!v) {
    return -1;
  }
  ma_data_source *source;
  uint32_t source_rate;
  if (desc->clip) {
    const fdw_audio_clip *clip = desc->clip;
    if (ma_audio_buffer_ref_init(ma_format_f32, clip->channels, clip->samples,
                                 clip->frames, &v->buffer) != MA_SUCCESS) {
      free(v);
      return -1;
    }
    // Not set by ma_audio_buffer_ref_init: the sound resamples from it.
    v->buffer.sampleRate = clip->sample_rate;
    source = &v->buffer;
    source_rate = clip->sample_rate;
  } else {
    ma_decoder_config config = ma_decoder_config_init(ma_format_f32, 0, 0);
    if (ma_decoder_init_memory(desc->blob->bytes, desc->blob->size, &config,
                               &v->decoder) != MA_SUCCESS) {
      free(v);
      return -1;
    }
    source = &v->decoder;
    source_rate = desc->blob->sample_rate;
  }
  const ma_uint32 flags = desc->spatial ? 0 : MA_SOUND_FLAG_NO_SPATIALIZATION;
  if (ma_sound_init_from_data_source(&audio->engine, source, flags,
                                     audio->buses[desc->bus],
                                     &v->sound) != MA_SUCCESS) {
    if (desc->clip) {
      ma_audio_buffer_ref_uninit(&v->buffer);
    } else {
      ma_decoder_uninit(&v->decoder);
    }
    free(v);
    return -1;
  }
  // The voice holds its source from here.
  if (desc->clip) {
    v->clip = desc->clip;
    v->clip->refs++;
  } else {
    v->blob = desc->blob;
    v->blob->refs++;
  }
  ma_sound *sound = &v->sound;
  ma_sound_set_volume(sound, desc->volume);
  ma_sound_set_pitch(sound, desc->pitch);
  ma_sound_set_looping(sound, desc->loop ? MA_TRUE : MA_FALSE);
  if (desc->spatial) {
    set_spatial(sound, desc);
  } else {
    // As the StereoPannerNode of WebAudio: a side moved into the other.
    ma_sound_set_pan_mode(sound, ma_pan_mode_pan);
    ma_sound_set_pan(sound, desc->pan);
  }
  if (desc->offset > 0) {
    ma_sound_seek_to_pcm_frame(sound,
                               (ma_uint64)(desc->offset * (float)source_rate));
  }
  if (desc->fade_in > 0) {
    ma_sound_set_fade_in_pcm_frames(sound, 0, 1,
                                    frames_of(audio, desc->fade_in));
  }
  v->paused = desc->paused;
  if (!desc->paused) {
    ma_sound_start(sound);
  }
  audio->voices[slot] = v;
  audio->generations[slot] = (audio->generations[slot] + 1) & 0x7fff;
  audio->count++;
  return (audio->generations[slot] << SLOT_BITS) | (slot + 1);
}

void fdw_audio_voice_set(fdw_audio *audio, int id, fdw_audio_param param,
                         float value) {
  voice *v = voice_of(audio, id);
  if (!v) {
    return;
  }
  switch (param) {
  case FDW_AUDIO_VOLUME:
    ma_sound_set_volume(&v->sound, value);
    break;
  case FDW_AUDIO_PITCH:
    ma_sound_set_pitch(&v->sound, value);
    break;
  case FDW_AUDIO_PAN:
    ma_sound_set_pan(&v->sound, value);
    break;
  case FDW_AUDIO_LOOP:
    ma_sound_set_looping(&v->sound, value != 0 ? MA_TRUE : MA_FALSE);
    break;
  }
}

void fdw_audio_voice_position(fdw_audio *audio, int id, float x, float y,
                              float z) {
  voice *v = voice_of(audio, id);
  if (v) {
    ma_sound_set_position(&v->sound, x, y, z);
  }
}

void fdw_audio_voice_fade(fdw_audio *audio, int id, float gain, float seconds) {
  voice *v = voice_of(audio, id);
  if (v) {
    // -1: from the current gain of the fade.
    ma_sound_set_fade_in_pcm_frames(&v->sound, -1, gain,
                                    frames_of(audio, seconds));
  }
}

void fdw_audio_voice_pause(fdw_audio *audio, int id, int paused) {
  voice *v = voice_of(audio, id);
  if (!v || v->paused == paused) {
    return;
  }
  v->paused = paused;
  if (paused) {
    ma_sound_stop(&v->sound);
  } else {
    ma_sound_start(&v->sound);
  }
}

void fdw_audio_voice_stop(fdw_audio *audio, int id, float seconds) {
  voice *v = voice_of(audio, id);
  if (!v) {
    return;
  }
  if (seconds > 0 && !v->paused) {
    ma_sound_stop_with_fade_in_pcm_frames(&v->sound, frames_of(audio, seconds));
  } else {
    ma_sound_stop(&v->sound);
  }
  v->paused = 0;
}

double fdw_audio_voice_time(fdw_audio *audio, int id) {
  voice *v = voice_of(audio, id);
  float cursor = 0;
  if (v) {
    ma_sound_get_cursor_in_seconds(&v->sound, &cursor);
  }
  return cursor;
}

fdw_audio_voice_state fdw_audio_voice_state_of(fdw_audio *audio, int id) {
  voice *v = voice_of(audio, id);
  if (!v) {
    return FDW_AUDIO_STOPPED;
  }
  if (v->paused) {
    return FDW_AUDIO_PAUSED;
  }
  return ma_sound_is_playing(&v->sound) && !ma_sound_at_end(&v->sound)
             ? FDW_AUDIO_PLAYING
             : FDW_AUDIO_STOPPED;
}

int fdw_audio_update(fdw_audio *audio, int *ended, int capacity) {
  int count = 0;
  for (int slot = 0; slot < audio->capacity && count < capacity; slot++) {
    voice *v = audio->voices[slot];
    if (!v || v->paused ||
        (ma_sound_is_playing(&v->sound) && !ma_sound_at_end(&v->sound))) {
      continue;
    }
    ended[count++] = (audio->generations[slot] << SLOT_BITS) | (slot + 1);
    audio->voices[slot] = NULL;
    audio->count--;
    free_voice(v);
  }
  return count;
}

int fdw_audio_voice_count(const fdw_audio *audio) { return audio->count; }
