// The tests of the editor talk to the desktop through this tool under
// Windows, as through xprobe (xprobe.c) under X11: real inputs (SendInput,
// as a user would give them, through the child window of the viewport), and
// the pixels of the screen (the child window included, which a capture of
// the page does not have). In device pixels: the tool is DPI aware.
//
// Commands, one per line on the standard input, an answer per line:
//   move <x> <y>             the pointer, in pixels of the screen
//   button <n> <down|up>     a button (1 left, 2 middle, 3 right)
//   key <keysym> <down|up>   a key, by its X name (a, Delete, Escape…)
//   pixel <x> <y>            answers "<r> <g> <b>"
//   region <x> <y> <w> <h>   answers the mean color "<r> <g> <b>"
//   sync                     answers "ok" once the inputs had time to land
// Built by the CMake of the addon (native/CMakeLists.txt).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// The X names of the keys the tests press, beyond the letters and digits.
static const struct {
  const char *name;
  WORD key;
} namedKeys[] = {
    {"Delete", VK_DELETE},     {"Escape", VK_ESCAPE},  {"Return", VK_RETURN},
    {"BackSpace", VK_BACK},    {"Tab", VK_TAB},        {"space", VK_SPACE},
    {"Shift_L", VK_LSHIFT},    {"Control_L", VK_LCONTROL},
    {"Alt_L", VK_LMENU},       {"Left", VK_LEFT},      {"Right", VK_RIGHT},
    {"Up", VK_UP},             {"Down", VK_DOWN},      {"F1", VK_F1},
    {"F2", VK_F2},
};

static WORD keyCode(const char *name) {
  if (name[0] != '\0' && name[1] == '\0') {
    const char c = name[0];
    if (c >= 'a' && c <= 'z') return (WORD)(c - 'a' + 'A');
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (WORD)c;
  }
  for (size_t i = 0; i < sizeof namedKeys / sizeof namedKeys[0]; i++) {
    if (strcmp(namedKeys[i].name, name) == 0) return namedKeys[i].key;
  }
  return 0;
}

// Answers "ok", or the error of SendInput (refused to a process without
// access to the desktop).
static void send(INPUT *input) {
  if (SendInput(1, input, sizeof *input) == 1) {
    puts("ok");
  } else {
    printf("error: SendInput failed (%lu)\n", GetLastError());
  }
}

int main(void) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  HDC screen = GetDC(NULL);
  char line[256];
  setvbuf(stdout, NULL, _IONBF, 0);
  while (fgets(line, sizeof line, stdin)) {
    int x, y, w, h;
    unsigned n;
    char name[64], state[8];
    if (sscanf(line, "move %d %d", &x, &y) == 2) {
      if (SetCursorPos(x, y)) {
        puts("ok");
      } else {
        printf("error: SetCursorPos failed (%lu)\n", GetLastError());
      }
    } else if (sscanf(line, "button %u %7s", &n, state) == 2) {
      const int down = strcmp(state, "down") == 0;
      const DWORD flags[3][2] = {
          {MOUSEEVENTF_LEFTUP, MOUSEEVENTF_LEFTDOWN},
          {MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MIDDLEDOWN},
          {MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_RIGHTDOWN},
      };
      if (n < 1 || n > 3) {
        puts("error: unknown button");
        continue;
      }
      INPUT input = {0};
      input.type = INPUT_MOUSE;
      input.mi.dwFlags = flags[n - 1][down];
      send(&input);
    } else if (sscanf(line, "key %63s %7s", name, state) == 2) {
      const WORD code = keyCode(name);
      if (code == 0) {
        puts("error: unknown key");
        continue;
      }
      INPUT input = {0};
      input.type = INPUT_KEYBOARD;
      input.ki.wVk = code;
      input.ki.dwFlags = strcmp(state, "down") == 0 ? 0 : KEYEVENTF_KEYUP;
      send(&input);
    } else if (sscanf(line, "pixel %d %d", &x, &y) == 2 ||
               sscanf(line, "region %d %d %d %d", &x, &y, &w, &h) == 4) {
      if (strncmp(line, "pixel", 5) == 0) w = h = 1;
      if (w <= 0 || h <= 0) {
        puts("error: empty region");
        continue;
      }
      // A copy of the screen as the desktop composes it, swapchains
      // included, in a top-down 32-bit DIB.
      BITMAPINFO info = {0};
      info.bmiHeader.biSize = sizeof info.bmiHeader;
      info.bmiHeader.biWidth = w;
      info.bmiHeader.biHeight = -h;
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      info.bmiHeader.biCompression = BI_RGB;
      void *bits = NULL;
      HBITMAP bitmap =
          CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, NULL, 0);
      HDC memory = CreateCompatibleDC(screen);
      HGDIOBJ previous = SelectObject(memory, bitmap);
      const BOOL copied = BitBlt(memory, 0, 0, w, h, screen, x, y, SRCCOPY);
      GdiFlush();
      if (!copied) {
        printf("error: no copy of the screen (%lu)\n", GetLastError());
      } else {
        unsigned long long r = 0, g = 0, b = 0;
        const unsigned char *pixel = (const unsigned char *)bits;
        for (int i = 0; i < w * h; i++, pixel += 4) {
          b += pixel[0];
          g += pixel[1];
          r += pixel[2];
        }
        const unsigned long long count = (unsigned long long)w * h;
        printf("%llu %llu %llu\n", r / count, g / count, b / count);
      }
      SelectObject(memory, previous);
      DeleteDC(memory);
      DeleteObject(bitmap);
    } else if (strncmp(line, "sync", 4) == 0) {
      // SendInput only queues the inputs: a frame of the desktop for them.
      Sleep(20);
      puts("ok");
    } else {
      puts("error: unknown command");
    }
  }
  ReleaseDC(NULL, screen);
  return 0;
}
