# Native part of the editor (P18 prototype): fdw_editor.node, the native
# viewport. A child X11 window placed in the Electron window, and a Vulkan
# swapchain drawing into it on a render thread of its own.
# The Vulkan headers, volk and glslc come from the Vulkan SDK (VULKAN_SDK).

cmake_minimum_required(VERSION 3.24)
project(fdw_editor LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

set(NODE_API_INCLUDE_DIR "" CACHE PATH "Directory of node_api.h")
if(NOT NODE_API_INCLUDE_DIR)
  message(FATAL_ERROR "NODE_API_INCLUDE_DIR is not set: build with scripts/build-native.mjs")
endif()
set(VULKAN_SDK "$ENV{VULKAN_SDK}" CACHE PATH "The Vulkan SDK (its x86_64 directory on Linux)")
if(NOT EXISTS "${VULKAN_SDK}/include/vulkan/vulkan.h")
  message(FATAL_ERROR "The Vulkan SDK was not found in '${VULKAN_SDK}': source its setup-env.sh")
endif()
set(SDK_INCLUDE "${VULKAN_SDK}/include")
if(NOT UNIX OR APPLE)
  message(FATAL_ERROR "The native viewport is only written for Linux (X11) so far")
endif()
find_package(X11 REQUIRED)
if(NOT X11_Xext_FOUND)
  message(FATAL_ERROR "libXext (the Shape extension) was not found")
endif()

# The shaders, compiled to SPIR-V words included by viewport.cpp.
find_program(GLSLC glslc HINTS "${VULKAN_SDK}/bin" REQUIRED)
set(SHADERS)
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/shaders")
foreach(stage vert frag)
  set(output "${CMAKE_CURRENT_BINARY_DIR}/shaders/triangle.${stage}.inc")
  add_custom_command(
    OUTPUT "${output}"
    COMMAND "${GLSLC}" -mfmt=num -o "${output}" "${CMAKE_CURRENT_SOURCE_DIR}/shaders/triangle.${stage}"
    DEPENDS shaders/triangle.${stage}
    VERBATIM)
  list(APPEND SHADERS "${output}")
endforeach()

add_library(fdw_editor_node MODULE src/viewport.cpp "${SDK_INCLUDE}/volk/volk.c" ${SHADERS})
target_include_directories(fdw_editor_node PRIVATE
  ${NODE_API_INCLUDE_DIR} "${CMAKE_CURRENT_BINARY_DIR}/shaders")
# The SDK headers are not ours: no warnings from them.
target_include_directories(fdw_editor_node SYSTEM PRIVATE "${SDK_INCLUDE}" "${SDK_INCLUDE}/volk")
target_compile_definitions(fdw_editor_node PRIVATE NAPI_VERSION=8 NODE_GYP_MODULE_NAME=fdw_editor
                                                   VK_USE_PLATFORM_XLIB_KHR)
target_link_libraries(fdw_editor_node PRIVATE X11::X11 X11::Xext ${CMAKE_DL_LIBS})
set_target_properties(fdw_editor_node PROPERTIES OUTPUT_NAME fdw_editor PREFIX "" SUFFIX ".node")
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(fdw_editor_node PRIVATE
    $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra -Wno-missing-field-initializers>)
endif()
