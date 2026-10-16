# Native part of @fdw/engine-native:
# - fdw_window: the window library (C API over SDL3), static;
# - fdw_image: the image decoder (stb_image, vendored in third_party), static;
# - fdw_native.node: their Node-API addon.
# Dependencies are fetched at fixed versions, the same on every platform.

cmake_minimum_required(VERSION 3.24)
project(fdw_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
# Static libraries linked into the shared addon.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

# Node-API headers: given by scripts/build.mjs (those of the running Node).
set(NODE_API_INCLUDE_DIR "" CACHE PATH "Directory of node_api.h")
if(NOT NODE_API_INCLUDE_DIR)
  message(FATAL_ERROR "NODE_API_INCLUDE_DIR is not set: build with scripts/build.mjs")
endif()

include(FetchContent)

set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)
set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  SDL3
  GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
  GIT_TAG release-3.2.0
  GIT_SHALLOW TRUE
  EXCLUDE_FROM_ALL
)
FetchContent_MakeAvailable(SDL3)

add_library(fdw_window STATIC src/window.cpp)
target_include_directories(fdw_window PUBLIC include)
target_link_libraries(fdw_window PRIVATE SDL3::SDL3-static)

add_library(fdw_image STATIC third_party/stb/stb_image.c)
target_include_directories(fdw_image PUBLIC third_party/stb)

add_library(fdw_native MODULE src/node_window.c src/node_image.c)
target_include_directories(fdw_native PRIVATE ${NODE_API_INCLUDE_DIR})
target_compile_definitions(fdw_native PRIVATE NAPI_VERSION=8
                                              NODE_GYP_MODULE_NAME=fdw_native)
target_link_libraries(fdw_native PRIVATE fdw_window fdw_image)
set_target_properties(fdw_native PROPERTIES PREFIX "" SUFFIX ".node")
if(APPLE)
  # Node-API symbols are resolved by the Node process.
  target_link_options(fdw_native PRIVATE -undefined dynamic_lookup)
endif()
if(WIN32)
  # Windows links against the import library of node.exe: to add with the
  # Windows port (node-api-headers provides its .def file).
  message(WARNING "The Windows build of the addon is not set up yet")
endif()
