// The addons are linked against an import library of node.exe, loaded late
// (/DELAYLOAD:node.exe): this hook gives them the process that loads them
// instead. Node-API is then resolved in node.exe as in an Electron process
// (electron.exe exports it too), whatever the name of the executable. The
// hook of node-gyp (win_delay_load_hook.cc), in C.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI loadHost(unsigned event, PDelayLoadInfo info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return (FARPROC)GetModuleHandleW(NULL);
  return NULL;
}

const PfnDliHook __pfnDliNotifyHook2 = loadHost;
