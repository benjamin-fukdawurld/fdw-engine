// The audio of the engine: a C API over miniaudio, usable from any host (the
// Node-API addon of @fdw/engine-native, a FFI, a native application).
// Mixing runs on the audio thread of miniaudio; every function of this API
// runs on one thread, the one of the host, except fdw_audio_clip_decode and
// fdw_audio_blob_create, which can run on any thread (a thread pool).

#ifndef FDW_AUDIO_H
#define FDW_AUDIO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define FDW_AUDIO_API __declspec(dllexport)
#else
#define FDW_AUDIO_API __attribute__((visibility("default")))
#endif

typedef struct fdw_audio fdw_audio;
// Decoded samples, shared by the voices playing them: a short sound.
typedef struct fdw_audio_clip fdw_audio_clip;
// Encoded bytes, decoded by each voice while it plays: music.
typedef struct fdw_audio_blob fdw_audio_blob;

typedef struct fdw_audio_desc {
  // 0: the rate of the device (48000 without device).
  uint32_t sample_rate;
  // 0: the channels of the device (2 without device).
  uint32_t channels;
  // No device: the mix is read by fdw_audio_render (tests, offline).
  int offline;
} fdw_audio_desc;

typedef enum fdw_audio_distance_model {
  FDW_AUDIO_DISTANCE_INVERSE = 0,
  FDW_AUDIO_DISTANCE_LINEAR = 1,
  FDW_AUDIO_DISTANCE_EXPONENTIAL = 2,
} fdw_audio_distance_model;

typedef struct fdw_audio_play_desc {
  // One of the two.
  fdw_audio_clip *clip;
  fdw_audio_blob *blob;
  // 0: the master bus.
  int bus;
  float volume;
  // The playback rate: 2 an octave up, and twice faster.
  float pitch;
  // -1 left, 1 right; ignored by a spatial voice.
  float pan;
  int loop;
  // Starts at, in seconds.
  float offset;
  // From silent to full in, seconds; 0: at once.
  float fade_in;
  int paused;
  // Placed in the world, heard from the listener.
  int spatial;
  float position[3];
  // The distance at which the attenuation starts, and the one past which
  // it stops.
  float ref_distance;
  float max_distance;
  float rolloff;
  fdw_audio_distance_model distance_model;
} fdw_audio_play_desc;

// The parameters of fdw_audio_voice_set.
typedef enum fdw_audio_param {
  FDW_AUDIO_VOLUME = 0,
  FDW_AUDIO_PITCH = 1,
  FDW_AUDIO_PAN = 2,
  FDW_AUDIO_LOOP = 3,
} fdw_audio_param;

typedef enum fdw_audio_voice_state {
  // Unknown or ended voice.
  FDW_AUDIO_STOPPED = 0,
  FDW_AUDIO_PLAYING = 1,
  FDW_AUDIO_PAUSED = 2,
} fdw_audio_voice_state;

// The engine, on the default device, or without device. NULL on failure,
// with the reason in *error (a static string).
FDW_AUDIO_API fdw_audio *fdw_audio_create(const fdw_audio_desc *desc,
                                          const char **error);
// Stops and frees the voices, then the engine.
FDW_AUDIO_API void fdw_audio_destroy(fdw_audio *audio);
FDW_AUDIO_API uint32_t fdw_audio_sample_rate(const fdw_audio *audio);
FDW_AUDIO_API uint32_t fdw_audio_channels(const fdw_audio *audio);
// The clock of the mix, in seconds.
FDW_AUDIO_API double fdw_audio_time(const fdw_audio *audio);
// Starts (1) or stops (0) the device.
FDW_AUDIO_API int fdw_audio_set_running(fdw_audio *audio, int running);
// Mixes `frames` frames into `out` (interleaved), on the calling thread.
// For an engine without device; returns the frames written.
FDW_AUDIO_API uint64_t fdw_audio_render(fdw_audio *audio, float *out,
                                        uint64_t frames);

// A bus under `parent` (0: the master). Returns its id, or -1.
FDW_AUDIO_API int fdw_audio_bus_create(fdw_audio *audio, int parent);
FDW_AUDIO_API void fdw_audio_bus_set_volume(fdw_audio *audio, int bus,
                                            float volume);

// The listener: where it is, where it looks, its up.
FDW_AUDIO_API void fdw_audio_listener(fdw_audio *audio, const float position[3],
                                      const float forward[3],
                                      const float up[3]);

// A clip from interleaved samples, copied.
FDW_AUDIO_API fdw_audio_clip *fdw_audio_clip_create(const float *samples,
                                                    uint64_t frames,
                                                    uint32_t channels,
                                                    uint32_t sample_rate);
// A clip decoded from a WAV, FLAC, MP3 or Ogg Vorbis file in memory, at its
// own rate. NULL on failure, with the reason in *error.
FDW_AUDIO_API fdw_audio_clip *
fdw_audio_clip_decode(const void *bytes, size_t length, const char **error);
FDW_AUDIO_API void fdw_audio_clip_info(const fdw_audio_clip *clip,
                                       uint64_t *frames, uint32_t *channels,
                                       uint32_t *sample_rate);
// The interleaved samples of a clip.
FDW_AUDIO_API const float *fdw_audio_clip_samples(const fdw_audio_clip *clip);
// Releases the reference of the caller: the clip is freed once the voices
// playing it are done.
FDW_AUDIO_API void fdw_audio_clip_release(fdw_audio_clip *clip);

// A blob from the bytes of a WAV, FLAC, MP3 or Ogg Vorbis file, copied, and
// checked to decode. NULL on failure, with the reason in *error.
FDW_AUDIO_API fdw_audio_blob *
fdw_audio_blob_create(const void *bytes, size_t length, const char **error);
// The duration in seconds (negative when unknown), the channels, the rate.
FDW_AUDIO_API void fdw_audio_blob_info(const fdw_audio_blob *blob,
                                       double *duration, uint32_t *channels,
                                       uint32_t *sample_rate);
FDW_AUDIO_API size_t fdw_audio_blob_size(const fdw_audio_blob *blob);
FDW_AUDIO_API void fdw_audio_blob_release(fdw_audio_blob *blob);

// Plays a clip or a blob. Returns the id of the voice (> 0), or -1.
FDW_AUDIO_API int fdw_audio_play(fdw_audio *audio,
                                 const fdw_audio_play_desc *desc);
// The calls on a voice that has ended do nothing.
FDW_AUDIO_API void fdw_audio_voice_set(fdw_audio *audio, int voice,
                                       fdw_audio_param param, float value);
FDW_AUDIO_API void fdw_audio_voice_position(fdw_audio *audio, int voice,
                                            float x, float y, float z);
// From the current fade gain to `gain` in `seconds`.
FDW_AUDIO_API void fdw_audio_voice_fade(fdw_audio *audio, int voice, float gain,
                                        float seconds);
FDW_AUDIO_API void fdw_audio_voice_pause(fdw_audio *audio, int voice,
                                         int paused);
// Fades out in `seconds` (0: at once), then ends.
FDW_AUDIO_API void fdw_audio_voice_stop(fdw_audio *audio, int voice,
                                        float seconds);
// Where the voice is in its sound, in seconds.
FDW_AUDIO_API double fdw_audio_voice_time(fdw_audio *audio, int voice);
FDW_AUDIO_API fdw_audio_voice_state fdw_audio_voice_state_of(fdw_audio *audio,
                                                             int voice);
// Frees the voices that have ended, and writes their ids into `ended` (up
// to `capacity`). Returns how many ended. To call at each frame.
FDW_AUDIO_API int fdw_audio_update(fdw_audio *audio, int *ended, int capacity);
// The voices alive (playing, paused or fading out).
FDW_AUDIO_API int fdw_audio_voice_count(const fdw_audio *audio);

#ifdef __cplusplus
}
#endif

#endif
