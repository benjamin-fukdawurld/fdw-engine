// The implementations of miniaudio and of stb_vorbis (its Vorbis decoder),
// compiled once. The options are set in CMakeLists.txt, for every file that
// includes miniaudio.h.

#define STB_VORBIS_HEADER_ONLY
#include "stb_vorbis.c"

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#undef STB_VORBIS_HEADER_ONLY
#include "stb_vorbis.c"
