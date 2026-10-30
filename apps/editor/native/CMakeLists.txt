# Native part of the editor (P18): fdw_editor.node, the native viewport. A
# child window placed in the Electron window; the engine presents into it
# with its own addon (@fdw/engine-vulkan, @fdw/engine-d3d12), or copies the
# frames of Dawn into it. X11 under Linux (viewport_x11.cpp), Win32 under
# Windows (viewport_win32.cpp).

cmake_minimum_required(VERSION 3.24)
project(fdw_editor LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../../tools/native/NodeApi.cmake)

# The probe of the end-to-end tests (tests/xprobe.c, tests/winprobe.c): the
# inputs and the pixels of the screen. In build/ itself, also with the
# multi-config generators.
if(WIN32)
  add_library(fdw_editor_node MODULE src/viewport_win32.cpp)
  target_link_libraries(fdw_editor_node PRIVATE user32 gdi32)
  add_executable(fdw_probe ../tests/winprobe.c)
  target_link_libraries(fdw_probe PRIVATE user32 gdi32)
  set_target_properties(fdw_probe PROPERTIES OUTPUT_NAME winprobe)
elseif(UNIX AND NOT APPLE)
  find_package(X11 REQUIRED)
  if(NOT X11_Xext_FOUND)
    message(FATAL_ERROR "libXext (the Shape and MIT-SHM extensions) was not found")
  endif()
  add_library(fdw_editor_node MODULE src/viewport_x11.cpp)
  target_link_libraries(fdw_editor_node PRIVATE X11::X11 X11::Xext)
  add_executable(fdw_probe ../tests/xprobe.c)
  target_link_libraries(fdw_probe PRIVATE X11::X11 ${CMAKE_DL_LIBS})
  set_target_properties(fdw_probe PROPERTIES OUTPUT_NAME xprobe)
else()
  message(FATAL_ERROR "The native viewport is written for Linux (X11) and Windows so far")
endif()
target_compile_definitions(fdw_editor_node PRIVATE NAPI_VERSION=8 NODE_GYP_MODULE_NAME=fdw_editor)
set_target_properties(fdw_editor_node PROPERTIES OUTPUT_NAME fdw_editor)
fdw_node_addon(fdw_editor_node)
set_target_properties(fdw_probe PROPERTIES RUNTIME_OUTPUT_DIRECTORY "$<1:${CMAKE_BINARY_DIR}>")
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(fdw_editor_node PRIVATE -Wall -Wextra -Wno-missing-field-initializers)
elseif(MSVC)
  target_compile_options(fdw_editor_node PRIVATE $<$<COMPILE_LANGUAGE:CXX>:/W4 /utf-8>)
endif()
