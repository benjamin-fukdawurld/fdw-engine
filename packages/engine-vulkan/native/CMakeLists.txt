# Native part of @fdw/engine-vulkan:
# - fdw_vulkan: the Vulkan library (C API), static;
# - fdw_vulkan.node: its Node-API addon.
# The Vulkan headers, volk and VMA come from the Vulkan SDK (VULKAN_SDK),
# required anyway for DXC. Vulkan itself is loaded at run time by volk.

cmake_minimum_required(VERSION 3.24)
project(fdw_vulkan LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../../tools/native/NodeApi.cmake)
set(VULKAN_SDK "$ENV{VULKAN_SDK}" CACHE PATH "The Vulkan SDK (its x86_64 directory on Linux)")
if(NOT EXISTS "${VULKAN_SDK}/include/vulkan/vulkan.h")
  message(FATAL_ERROR "The Vulkan SDK was not found in '${VULKAN_SDK}': source its setup-env.sh")
endif()
set(SDK_INCLUDE "${VULKAN_SDK}/include")

add_library(fdw_vulkan STATIC
  src/context.cpp
  src/buffer.cpp
  src/texture.cpp
  src/tracking.cpp
  src/commands.cpp
  src/shader.cpp
  src/pipeline.cpp
  src/swapchain.cpp
  src/queries.cpp
  src/rays.cpp
  src/vma.cpp
  "${SDK_INCLUDE}/volk/volk.c"
)
target_include_directories(fdw_vulkan PUBLIC include)
# The SDK headers are not ours: no warnings from them.
target_include_directories(fdw_vulkan SYSTEM PRIVATE
  "${SDK_INCLUDE}" "${SDK_INCLUDE}/volk" "${SDK_INCLUDE}/vma" "${SDK_INCLUDE}/dxc"
)
target_link_libraries(fdw_vulkan PRIVATE ${CMAKE_DL_LIBS})
# The window systems the swapchains can present into (volk loads their
# functions: volk.c is part of the library).
if(WIN32)
  target_compile_definitions(fdw_vulkan PRIVATE VK_USE_PLATFORM_WIN32_KHR NOMINMAX)
elseif(UNIX AND NOT APPLE)
  find_path(X11_XLIB_INCLUDE X11/Xlib.h)
  if(X11_XLIB_INCLUDE)
    target_compile_definitions(fdw_vulkan PRIVATE VK_USE_PLATFORM_XLIB_KHR)
  endif()
  find_path(WAYLAND_CLIENT_INCLUDE wayland-client.h)
  if(WAYLAND_CLIENT_INCLUDE)
    target_compile_definitions(fdw_vulkan PRIVATE VK_USE_PLATFORM_WAYLAND_KHR)
  endif()
endif()
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(fdw_vulkan PRIVATE
    $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra -Wno-missing-field-initializers>)
endif()

add_library(fdw_vulkan_node MODULE src/node_vulkan.c)
fdw_node_addon(fdw_vulkan_node)
target_compile_definitions(fdw_vulkan_node PRIVATE NAPI_VERSION=8
                                                   NODE_GYP_MODULE_NAME=fdw_vulkan)
target_link_libraries(fdw_vulkan_node PRIVATE fdw_vulkan)
set_target_properties(fdw_vulkan_node PROPERTIES OUTPUT_NAME fdw_vulkan)
