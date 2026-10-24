// Shaders: HLSL compiled to DXIL by the DXC library, loaded at run time with
// its validator (dxil.dll), which signs the DXIL as Direct3D 12 needs.

#include "context.hpp"

#include <dxcapi.h>

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

using namespace fdw;

namespace {

// The entry of the DXC library, loaded once.
DxcCreateInstanceProc createInstance = nullptr;

// The directories of the Windows SDK binaries, the newest first: their
// dxcompiler.dll and dxil.dll go together.
std::vector<std::filesystem::path> windowsSdkDirectories() {
  std::vector<std::filesystem::path> result;
  const char *programs = std::getenv("ProgramFiles(x86)");
  const std::filesystem::path bin =
      std::filesystem::path(programs ? programs : "C:\\Program Files (x86)") /
      "Windows Kits" / "10" / "bin";
  std::error_code error;
  for (const auto &entry : std::filesystem::directory_iterator(bin, error)) {
    if (entry.is_directory() &&
        entry.path().filename().string().rfind("10.", 0) == 0) {
      result.push_back(entry.path() / "x64");
    }
  }
  std::sort(result.begin(), result.end(),
            [](const auto &a, const auto &b) { return a > b; });
  return result;
}

// Loads dxcompiler.dll from a directory, with the dxil.dll there first:
// DXC finds it by name to sign what it compiles.
bool loadFrom(const std::filesystem::path &directory) {
  const std::filesystem::path compiler = directory / "dxcompiler.dll";
  std::error_code error;
  if (!directory.empty() && !std::filesystem::exists(compiler, error)) {
    return false;
  }
  const std::filesystem::path validator = directory / "dxil.dll";
  if (!directory.empty() && std::filesystem::exists(validator, error)) {
    LoadLibraryW(validator.c_str());
  } else if (directory.empty()) {
    LoadLibraryW(L"dxil.dll");
  }
  HMODULE library = LoadLibraryW(
      directory.empty() ? L"dxcompiler.dll" : compiler.c_str());
  if (!library) {
    return false;
  }
  createInstance = reinterpret_cast<DxcCreateInstanceProc>(
      GetProcAddress(library, "DxcCreateInstance"));
  return createInstance != nullptr;
}

// Loads the DXC library: FDW_DXC_LIBRARY (dxcompiler.dll, dxil.dll beside
// it), the Windows SDK, the Vulkan SDK, the system.
int loadDxc() {
  if (createInstance) {
    return 0;
  }
  std::vector<std::filesystem::path> candidates;
  if (const char *path = std::getenv("FDW_DXC_LIBRARY")) {
    candidates.push_back(std::filesystem::path(path).parent_path());
  }
  for (const auto &directory : windowsSdkDirectories()) {
    candidates.push_back(directory);
  }
  if (const char *sdk = std::getenv("VULKAN_SDK")) {
    candidates.push_back(std::filesystem::path(sdk) / "Bin");
  }
  // The system search path.
  candidates.emplace_back();
  for (const auto &candidate : candidates) {
    if (loadFrom(candidate)) {
      return 0;
    }
  }
  return fail("The DXC library (dxcompiler.dll) was not found: install the "
              "Windows SDK, or set FDW_DXC_LIBRARY");
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

namespace fdw {

int compileHlsl(const char *hlsl, const char *const *arguments,
                uint32_t count, std::vector<uint8_t> *bytecode) {
  if (loadDxc() != 0) {
    return -1;
  }
  ComPtr<IDxcCompiler3> compiler;
  if (FAILED(createInstance(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) {
    return fail("DxcCreateInstance failed");
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
  ComPtr<IDxcResult> result;
  if (FAILED(compiler->Compile(&source, pointers.data(),
                               static_cast<UINT32>(pointers.size()), nullptr,
                               IID_PPV_ARGS(&result)))) {
    return fail("DXC failed to run");
  }
  HRESULT status = S_OK;
  result->GetStatus(&status);
  if (FAILED(status)) {
    ComPtr<IDxcBlobUtf8> errors;
    result->GetOutput(DXC_OUT_ERRORS, IID_PPV_ARGS(&errors), nullptr);
    return fail(std::string("DXC: ") +
                (errors && errors->GetStringLength() > 0
                     ? errors->GetStringPointer()
                     : "compilation failed"));
  }
  ComPtr<IDxcBlob> object;
  result->GetOutput(DXC_OUT_OBJECT, IID_PPV_ARGS(&object), nullptr);
  if (!object || object->GetBufferSize() == 0) {
    return fail("DXC produced no DXIL");
  }
  const auto *data = static_cast<const uint8_t *>(object->GetBufferPointer());
  bytecode->assign(data, data + object->GetBufferSize());
  return 0;
}

} // namespace fdw

extern "C" {

fdw_dx_shader *fdw_dx_shader_create(fdw_dx_context *context, const char *hlsl,
                                    const char *const *arguments,
                                    uint32_t count, const char *) {
  auto *shader = new fdw_dx_shader();
  if (compileHlsl(hlsl, arguments, count, &shader->bytecode) != 0) {
    delete shader;
    return nullptr;
  }
  shader->stage = option(arguments, count, "-T").c_str()[0];
  context->shaders.insert(shader);
  return shader;
}

void fdw_dx_shader_destroy(fdw_dx_context *context, fdw_dx_shader *shader) {
  if (!shader || !context->shaders.erase(shader)) {
    return;
  }
  // The pipelines keep what they need: the bytecode can go now.
  delete shader;
}

} // extern "C"
