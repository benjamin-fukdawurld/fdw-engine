// Shaders: HLSL compiled to SPIR-V by the DXC library, loaded at run time.

#include "context.hpp"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include <dxc/dxcapi.h>

#if defined(_WIN32)
// Elsewhere, dxcapi.h defines CComPtr; on Windows it is ATL's, an optional
// part of Visual Studio: WRL's, from the Windows SDK, instead.
#include <wrl/client.h>
template <typename T> using CComPtr = Microsoft::WRL::ComPtr<T>;
#endif

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using namespace fdw;

namespace {

// The entry of the DXC library, loaded once.
DxcCreateInstanceProc createInstance = nullptr;

#if defined(_WIN32)
constexpr const char *libraryName = "dxcompiler.dll";
#elif defined(__APPLE__)
constexpr const char *libraryName = "libdxcompiler.dylib";
#else
constexpr const char *libraryName = "libdxcompiler.so";
#endif

void *openLibrary(const std::string &path) {
#if defined(_WIN32)
  return reinterpret_cast<void *>(LoadLibraryA(path.c_str()));
#else
  return dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif
}

void *symbol(void *library, const char *name) {
#if defined(_WIN32)
  return reinterpret_cast<void *>(
      GetProcAddress(static_cast<HMODULE>(library), name));
#else
  return dlsym(library, name);
#endif
}

// Loads the DXC library: FDW_DXC_LIBRARY, the Vulkan SDK, the system.
int loadDxc() {
  if (createInstance) {
    return 0;
  }
  std::vector<std::string> candidates;
  if (const char *path = std::getenv("FDW_DXC_LIBRARY")) {
    candidates.push_back(path);
  }
  if (const char *sdk = std::getenv("VULKAN_SDK")) {
#if defined(_WIN32)
    candidates.push_back(std::string(sdk) + "/Bin/" + libraryName);
#else
    candidates.push_back(std::string(sdk) + "/lib/" + libraryName);
#endif
  }
  candidates.push_back(libraryName);
  for (const std::string &candidate : candidates) {
    if (void *library = openLibrary(candidate)) {
      createInstance = reinterpret_cast<DxcCreateInstanceProc>(
          symbol(library, "DxcCreateInstance"));
      if (createInstance) {
        return 0;
      }
    }
  }
  return fail(std::string("The DXC library (") + libraryName +
              ") was not found: set FDW_DXC_LIBRARY or VULKAN_SDK");
}

std::wstring wide(const char *text) {
  // The arguments are ASCII (options, entry points, profiles).
  std::wstring result;
  for (const char *c = text; *c; c++) {
    result.push_back(static_cast<wchar_t>(*c));
  }
  return result;
}

// The value following an option in the arguments ("-T vs_6_0").
std::string option(const char *const *arguments, uint32_t count,
                   const char *name) {
  for (uint32_t i = 0; i + 1 < count; i++) {
    if (std::strcmp(arguments[i], name) == 0) {
      return arguments[i + 1];
    }
  }
  return "";
}

} // namespace

extern "C" {

fdw_vk_shader *fdw_vk_shader_create(fdw_vk_context *context, const char *hlsl,
                                    const char *const *arguments,
                                    uint32_t count, const char *label) {
  if (loadDxc() != 0) {
    return nullptr;
  }
  CComPtr<IDxcUtils> utils;
  CComPtr<IDxcCompiler3> compiler;
  if (FAILED(createInstance(CLSID_DxcUtils, IID_PPV_ARGS(&utils))) ||
      FAILED(createInstance(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) {
    fail("DxcCreateInstance failed");
    return nullptr;
  }

  std::vector<std::wstring> wideArguments;
  for (uint32_t i = 0; i < count; i++) {
    wideArguments.push_back(wide(arguments[i]));
  }
  std::vector<LPCWSTR> pointers;
  for (const std::wstring &argument : wideArguments) {
    pointers.push_back(argument.c_str());
  }
  DxcBuffer source{hlsl, std::strlen(hlsl), DXC_CP_UTF8};
  CComPtr<IDxcResult> result;
  if (FAILED(compiler->Compile(&source, pointers.data(),
                               static_cast<UINT32>(pointers.size()), nullptr,
                               IID_PPV_ARGS(&result)))) {
    fail("DXC failed to run");
    return nullptr;
  }
  HRESULT status = S_OK;
  result->GetStatus(&status);
  if (FAILED(status)) {
    CComPtr<IDxcBlobUtf8> errors;
    result->GetOutput(DXC_OUT_ERRORS, IID_PPV_ARGS(&errors), nullptr);
    fail(std::string("DXC: ") +
         (errors && errors->GetStringLength() > 0 ? errors->GetStringPointer()
                                                  : "compilation failed"));
    return nullptr;
  }
  CComPtr<IDxcBlob> spirv;
  result->GetOutput(DXC_OUT_OBJECT, IID_PPV_ARGS(&spirv), nullptr);
  if (!spirv || spirv->GetBufferSize() == 0) {
    fail("DXC produced no SPIR-V");
    return nullptr;
  }

  VkShaderModuleCreateInfo info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
  info.codeSize = spirv->GetBufferSize();
  info.pCode = static_cast<const uint32_t *>(spirv->GetBufferPointer());
  auto *shader = new fdw_vk_shader();
  const VkResult created =
      vkCreateShaderModule(context->device, &info, nullptr, &shader->module);
  if (created != VK_SUCCESS) {
    delete shader;
    fail("vkCreateShaderModule", created);
    return nullptr;
  }
  const std::string profile = option(arguments, count, "-T");
  // A library: the shaders of a ray tracing pipeline (its ray generation
  // shader stands for them).
  shader->stage = profile.rfind("ps", 0) == 0    ? VK_SHADER_STAGE_FRAGMENT_BIT
                  : profile.rfind("cs", 0) == 0  ? VK_SHADER_STAGE_COMPUTE_BIT
                  : profile.rfind("lib", 0) == 0 ? VK_SHADER_STAGE_RAYGEN_BIT_KHR
                                                 : VK_SHADER_STAGE_VERTEX_BIT;
  shader->entryPoint = option(arguments, count, "-E");
  if (shader->entryPoint.empty()) {
    shader->entryPoint = "main";
  }
  setName(context, VK_OBJECT_TYPE_SHADER_MODULE,
          reinterpret_cast<uint64_t>(shader->module), label);
  context->shaders.insert(shader);
  return shader;
}

void fdw_vk_shader_destroy(fdw_vk_context *context, fdw_vk_shader *shader) {
  if (!shader || !context->shaders.erase(shader)) {
    return;
  }
  // The pipelines keep what they need: the module can go now.
  vkDestroyShaderModule(context->device, shader->module, nullptr);
  delete shader;
}

} // extern "C"
