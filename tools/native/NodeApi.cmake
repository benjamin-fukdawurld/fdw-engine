# Node-API setup shared by the native packages (engine-native,
# engine-vulkan). Its headers and .def file come from node-api-headers, given
# by build-addon.mjs.

set(NODE_API_INCLUDE_DIR "" CACHE PATH "Directory of node_api.h")
set(NODE_API_DEF "" CACHE FILEPATH "node_api.def of node-api-headers (Windows)")
if(NOT NODE_API_INCLUDE_DIR)
  message(FATAL_ERROR "NODE_API_INCLUDE_DIR is not set: build with scripts/build.mjs")
endif()

# Makes `target` (a MODULE library) a Node-API addon: `<name>.node`.
function(fdw_node_addon target)
  target_include_directories(${target} PRIVATE ${NODE_API_INCLUDE_DIR})
  # In build/ itself, also with the multi-config generators (Visual Studio),
  # which add a directory per configuration otherwise.
  set_target_properties(${target} PROPERTIES PREFIX "" SUFFIX ".node"
    LIBRARY_OUTPUT_DIRECTORY "$<1:${CMAKE_BINARY_DIR}>")
  if(APPLE)
    # Node-API symbols are resolved by the Node process.
    target_link_options(${target} PRIVATE -undefined dynamic_lookup)
  elseif(WIN32)
    # Linked against an import library of node.exe, made from the .def file.
    if(NOT NODE_API_DEF)
      message(FATAL_ERROR "NODE_API_DEF is not set: build with scripts/build.mjs")
    endif()
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|aarch64")
      set(machine ARM64)
    else()
      set(machine X64)
    endif()
    set(lib "${CMAKE_BINARY_DIR}/node_api.lib")
    if(NOT TARGET fdw_node_api_lib)
      add_custom_command(
        OUTPUT ${lib}
        COMMAND ${CMAKE_AR} /nologo /def:${NODE_API_DEF} /out:${lib} /machine:${machine}
        DEPENDS ${NODE_API_DEF}
        VERBATIM)
      add_custom_target(fdw_node_api_lib DEPENDS ${lib})
    endif()
    add_dependencies(${target} fdw_node_api_lib)
    target_link_libraries(${target} PRIVATE ${lib})
    # The import library of the addon, apart: it can have the name of a
    # static library of the project.
    set_target_properties(${target} PROPERTIES
      ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/addon-import")
  endif()
endfunction()
