// The implementation of stb_image (v2.30, public domain), compiled once.
// Only the formats of the engine; no file I/O: images are decoded from
// memory, read by the resource sources.
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_STDIO
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_TGA
#define STBI_ONLY_BMP
#define STBI_ONLY_GIF
#define STBI_ONLY_HDR
#include "stb_image.h"
