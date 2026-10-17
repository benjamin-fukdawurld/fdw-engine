#ifndef FDW_NODE_AUDIO_H
#define FDW_NODE_AUDIO_H

#include <node_api.h>

// Adds the audio functions (audioCreate, audioPlay…) to the exports of the
// addon.
napi_status fdw_register_audio(napi_env env, napi_value exports);

#endif
