// The tests of the editor talk to the X server through this tool: real
// inputs (the XTest extension, as a user would give them, through the
// child window of the viewport), and the pixels of the screen (the child
// window included, which a capture of the page does not have). XTest is
// opened at run time, without its headers (libxtst-dev).
//
// Commands, one per line on the standard input, an answer per line:
//   move <x> <y>             the pointer, in pixels of the screen
//   button <n> <down|up>     a button (1 left, 2 middle, 3 right)
//   key <keysym> <down|up>   a key, by name (XStringToKeysym: a, Delete…)
//   pixel <x> <y>            answers "<r> <g> <b>"
//   region <x> <y> <w> <h>   answers the mean color "<r> <g> <b>"
//   sync                     answers "ok" once the server has done the rest
// Build: cc -O1 -o xprobe xprobe.c -lX11 -ldl
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef int (*FakeMotion)(Display *, int, int, int, unsigned long);
typedef int (*FakeButton)(Display *, unsigned, Bool, unsigned long);
typedef int (*FakeKey)(Display *, unsigned, Bool, unsigned long);

int main(void) {
  Display *display = XOpenDisplay(NULL);
  if (!display) {
    fprintf(stderr, "xprobe: no display\n");
    return 1;
  }
  void *xtst = dlopen("libXtst.so.6", RTLD_NOW);
  if (!xtst) {
    fprintf(stderr, "xprobe: no libXtst.so.6\n");
    return 1;
  }
  FakeMotion motion = (FakeMotion)dlsym(xtst, "XTestFakeMotionEvent");
  FakeButton button = (FakeButton)dlsym(xtst, "XTestFakeButtonEvent");
  FakeKey key = (FakeKey)dlsym(xtst, "XTestFakeKeyEvent");
  Window root = DefaultRootWindow(display);
  int screen = DefaultScreen(display);

  char line[256];
  setvbuf(stdout, NULL, _IOLBF, 0);
  while (fgets(line, sizeof line, stdin)) {
    int x, y, w, h;
    unsigned n;
    char name[64], state[8];
    if (sscanf(line, "move %d %d", &x, &y) == 2) {
      motion(display, screen, x, y, CurrentTime);
      XFlush(display);
      puts("ok");
    } else if (sscanf(line, "button %u %7s", &n, state) == 2) {
      button(display, n, strcmp(state, "down") == 0, CurrentTime);
      XFlush(display);
      puts("ok");
    } else if (sscanf(line, "key %63s %7s", name, state) == 2) {
      KeyCode code = XKeysymToKeycode(display, XStringToKeysym(name));
      if (code == 0) {
        puts("error: unknown key");
        continue;
      }
      key(display, code, strcmp(state, "down") == 0, CurrentTime);
      XFlush(display);
      puts("ok");
    } else if (sscanf(line, "pixel %d %d", &x, &y) == 2 ||
               sscanf(line, "region %d %d %d %d", &x, &y, &w, &h) == 4) {
      if (strncmp(line, "pixel", 5) == 0) w = h = 1;
      XImage *image = XGetImage(display, root, x, y, (unsigned)w, (unsigned)h,
                                AllPlanes, ZPixmap);
      if (!image) {
        puts("error: outside of the screen");
        continue;
      }
      unsigned long r = 0, g = 0, b = 0;
      for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
          unsigned long p = XGetPixel(image, i, j);
          r += (p & image->red_mask) >> 16;
          g += (p & image->green_mask) >> 8;
          b += p & image->blue_mask;
        }
      }
      unsigned long count = (unsigned long)w * (unsigned long)h;
      printf("%lu %lu %lu\n", r / count, g / count, b / count);
      XDestroyImage(image);
    } else if (strncmp(line, "sync", 4) == 0) {
      XSync(display, False);
      puts("ok");
    } else {
      puts("error: unknown command");
    }
  }
  XCloseDisplay(display);
  return 0;
}
