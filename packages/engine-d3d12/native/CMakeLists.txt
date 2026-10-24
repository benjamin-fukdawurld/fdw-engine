# Native part of @fdw/engine-d3d12 (Windows only):
# - fdw_d3d12: the Direct3D 12 library (C API), static;
# - fdw_d3d12.node: its Node-API addon.
# Direct3D 12 and DXGI come from the Windows SDK; DXC (dxcompiler.dll and
# dxil.dll) is loaded at run time, its header is that of the Windows SDK.

cmake_minimum_required(VERSION 3.24)
project(fdw_d3d12 LANGUAGES C CXX)

if(NOT WIN32)
  message(FATAL_ERROR "Direct3D 12 is only available on Windows")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../../tools/native/NodeApi.cmake)

add_library(fdw_d3d12 STATIC
  src/context.cpp
  src/buffer.cpp
  src/texture.cpp
  src/tracking.cpp
  src/commands.cpp
  src/shader.cpp
  src/pipeline.cpp
  src/mipmaps.cpp
  src/swapchain.cpp
  src/queries.cpp
)
target_include_directories(fdw_d3d12 PUBLIC include)
target_compile_definitions(fdw_d3d12 PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
target_link_libraries(fdw_d3d12 PRIVATE d3d12 dxgi dxguid)
if(MSVC)
  target_compile_options(fdw_d3d12 PRIVATE /W4 /wd4100 /permissive-)
endif()

add_library(fdw_d3d12_node MODULE src/node_d3d12.c)
fdw_node_addon(fdw_d3d12_node)
target_compile_definitions(fdw_d3d12_node PRIVATE NAPI_VERSION=8
                                                  NODE_GYP_MODULE_NAME=fdw_d3d12)
target_link_libraries(fdw_d3d12_node PRIVATE fdw_d3d12)
set_target_properties(fdw_d3d12_node PROPERTIES OUTPUT_NAME fdw_d3d12)
