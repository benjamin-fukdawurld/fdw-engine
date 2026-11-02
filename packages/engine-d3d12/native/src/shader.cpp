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

// The entry of the DXC library, loaded once, and that of its validator
// (dxil.dll), when one was loaded.
DxcCreateInstanceProc createInstance = nullptr;
DxcCreateInstanceProc createValidator = nullptr;

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
  HMODULE signer = nullptr;
  if (!directory.empty() && std::filesystem::exists(validator, error)) {
    signer = LoadLibraryW(validator.c_str());
  } else if (directory.empty()) {
    signer = LoadLibraryW(L"dxil.dll");
  }
  HMODULE library = LoadLibraryW(
      directory.empty() ? L"dxcompiler.dll" : compiler.c_str());
  const auto entry = library ? reinterpret_cast<DxcCreateInstanceProc>(
                                   GetProcAddress(library, "DxcCreateInstance"))
                             : nullptr;
  if (!entry) {
    // Unloaded: the DXC of another candidate would find this validator
    // by name, though it may not go with it.
    if (library) {
      FreeLibrary(library);
    }
    if (signer) {
      FreeLibrary(signer);
    }
    return false;
  }
  createInstance = entry;
  createValidator =
      signer ? reinterpret_cast<DxcCreateInstanceProc>(
                   GetProcAddress(signer, "DxcCreateInstance"))
             : nullptr;
  return true;
}

// The directory of the addon, where the prebuilt addons bring DXC
// (tools/native/build-addon.mjs).
std::filesystem::path addonDirectory() {
  HMODULE module = nullptr;
  wchar_t path[MAX_PATH];
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(&addonDirectory),
                          &module) ||
      GetModuleFileNameW(module, path, MAX_PATH) == 0) {
    return {};
  }
  return std::filesystem::path(path).parent_path();
}

// Loads the DXC library: FDW_DXC_LIBRARY (dxcompiler.dll, dxil.dll beside
// it), beside the addon, the Windows SDK, the Vulkan SDK, the system.
int loadDxc() {
  if (createInstance) {
    return 0;
  }
  std::vector<std::filesystem::path> candidates;
  if (const char *path = std::getenv("FDW_DXC_LIBRARY")) {
    candidates.push_back(std::filesystem::path(path).parent_path());
  }
  if (const auto directory = addonDirectory(); !directory.empty()) {
    candidates.push_back(directory);
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
    if (arguments[i] && arguments[i + 1] &&
        std::strcmp(arguments[i], name) == 0) {
      return arguments[i + 1];
    }
  }
  return "";
}

// The arguments are all given (no NULL among them).
int checkArguments(const char *const *arguments, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    if (!arguments || !arguments[i]) {
      return fail("A DXC argument is missing");
    }
  }
  return 0;
}

// The version of a DXC component (compiler or validator), with its commit
// when it tells it.
std::string componentVersion(IUnknown *component) {
  ComPtr<IDxcVersionInfo> info;
  UINT32 major = 0, minor = 0;
  if (!component || FAILED(component->QueryInterface(IID_PPV_ARGS(&info))) ||
      FAILED(info->GetVersion(&major, &minor))) {
    return "";
  }
  std::string version = std::to_string(major) + "." + std::to_string(minor);
  ComPtr<IDxcVersionInfo2> commit;
  UINT32 commits = 0;
  char *hash = nullptr;
  if (SUCCEEDED(info.As(&commit)) &&
      SUCCEEDED(commit->GetCommitInfo(&commits, &hash)) && hash) {
    version += std::string(" ") + hash;
    CoTaskMemFree(hash);
  }
  return version;
}

// Whether code is a whole DXIL container: its magic ("DXBC"), its size, and
// its parts inside it. A corrupt entry of a cache is refused here, not by
// the driver.
bool dxilContainer(const uint8_t *code, size_t size) {
  constexpr size_t HeaderSize = 32;
  if (size < HeaderSize || std::memcmp(code, "DXBC", 4) != 0) {
    return false;
  }
  uint32_t total = 0;
  uint32_t parts = 0;
  std::memcpy(&total, code + 24, 4);
  std::memcpy(&parts, code + 28, 4);
  if (total != size || parts > (size - HeaderSize) / 4) {
    return false;
  }
  for (uint32_t part = 0; part < parts; part++) {
    uint32_t offset = 0;
    std::memcpy(&offset, code + HeaderSize + part * 4, 4);
    // A part: its fourcc, its size, then its data.
    uint32_t length = 0;
    if (offset > size || size - offset < 8) {
      return false;
    }
    std::memcpy(&length, code + offset + 4, 4);
    if (length > size - offset - 8) {
      return false;
    }
  }
  return true;
}

} // namespace

namespace fdw {

int compileHlsl(const char *hlsl, const char *const *arguments,
                uint32_t count, std::vector<uint8_t> *bytecode) {
  if (checkArguments(arguments, count) != 0 || loadDxc() != 0) {
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

const char *fdw_dx_dxc_version(void) {
  static std::string version;
  if (!version.empty()) {
    return version.c_str();
  }
  if (loadDxc() != 0) {
    return nullptr;
  }
  ComPtr<IUnknown> compiler;
  std::string compilerVersion;
  if (SUCCEEDED(createInstance(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) {
    compilerVersion = componentVersion(compiler.Get());
  }
  if (compilerVersion.empty()) {
    fail("The version of DXC is unknown");
    return nullptr;
  }
  // The validator signs the DXIL: another one, another program.
  ComPtr<IUnknown> validator;
  std::string validatorVersion;
  if (createValidator &&
      SUCCEEDED(createValidator(CLSID_DxcValidator, IID_PPV_ARGS(&validator)))) {
    validatorVersion = componentVersion(validator.Get());
  }
  version = compilerVersion + " dxil " +
            (validatorVersion.empty() ? "none" : validatorVersion);
  return version.c_str();
}

int fdw_dx_compile_hlsl(const char *hlsl, const char *const *arguments,
                        uint32_t count, uint8_t **code, size_t *size) {
  std::vector<uint8_t> compiled;
  if (compileHlsl(hlsl, arguments, count, &compiled) != 0) {
    return -1;
  }
  *code = static_cast<uint8_t *>(std::malloc(compiled.size()));
  std::memcpy(*code, compiled.data(), compiled.size());
  *size = compiled.size();
  return 0;
}

void fdw_dx_free_code(uint8_t *code) { std::free(code); }

fdw_dx_shader *fdw_dx_shader_create_from_code(fdw_dx_context *context,
                                              const uint8_t *code, size_t size,
                                              const char *const *arguments,
                                              uint32_t count, const char *) {
  if (size == 0) {
    fail("No DXIL");
    return nullptr;
  }
  if (!dxilContainer(code, size)) {
    fail("The code is not a DXIL container (DXBC): compile it again");
    return nullptr;
  }
  if (checkArguments(arguments, count) != 0) {
    return nullptr;
  }
  auto *shader = new fdw_dx_shader();
  shader->bytecode.assign(code, code + size);
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
