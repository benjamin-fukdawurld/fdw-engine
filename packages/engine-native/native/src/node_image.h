#ifndef FDW_NODE_IMAGE_H
#define FDW_NODE_IMAGE_H

#include <node_api.h>

// Adds decodeImage to the exports of the addon.
napi_status fdw_register_image(napi_env env, napi_value exports);

#endif
