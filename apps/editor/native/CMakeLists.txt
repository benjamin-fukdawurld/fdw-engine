# Native part of the editor (P18): fdw_editor.node, the native viewport. A
# child X11 window placed in the Electron window; the engine presents into it
# with its own Vulkan addon (@fdw/engine-vulkan).

cmake_minimum_required(VERSION 3.24)
project(fdw_editor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

set(NODE_API_INCLUDE_DIR "" CACHE PATH "Directory of node_api.h")
if(NOT NODE_API_INCLUDE_DIR)
  message(FATAL_ERROR "NODE_API_INCLUDE_DIR is not set: build with scripts/build-native.mjs")
endif()
if(NOT UNIX OR APPLE)
  message(FATAL_ERROR "The native viewport is only written for Linux (X11) so far")
endif()
find_package(X11 REQUIRED)
if(NOT X11_Xext_FOUND)
  message(FATAL_ERROR "libXext (the Shape extension) was not found")
endif()

add_library(fdw_editor_node MODULE src/viewport.cpp)
target_include_directories(fdw_editor_node PRIVATE ${NODE_API_INCLUDE_DIR})
target_compile_definitions(fdw_editor_node PRIVATE NAPI_VERSION=8 NODE_GYP_MODULE_NAME=fdw_editor)
target_link_libraries(fdw_editor_node PRIVATE X11::X11 X11::Xext)
set_target_properties(fdw_editor_node PROPERTIES OUTPUT_NAME fdw_editor PREFIX "" SUFFIX ".node")
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(fdw_editor_node PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
endif()
