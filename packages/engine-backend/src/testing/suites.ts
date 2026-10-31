// The suites of tests that need a GPU, a SDK, a display or a native addon:
// on a workstation, they are skipped where these are missing; in the CI,
// FDW_REQUIRE_SUITES lists those that must run (`vulkan,dawn,hlsl,window`
// or `all`), so that a missing one fails instead of passing silently.

const required = (): string[] =>
  (
    (globalThis as { process?: { env: Record<string, string | undefined> } })
      .process?.env['FDW_REQUIRE_SUITES'] ?? ''
  )
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * Whether the suite `name` can run (`ready`). Where it cannot, false — the
 * suite is skipped — unless FDW_REQUIRE_SUITES requires it: then it throws,
 * with `reason`.
 */
export function canRun(name: string, ready: boolean, reason = ''): boolean {
  if (ready) {
    return true;
  }
  const names = required();
  if (names.includes(name) || names.includes('all')) {
    throw new Error(
      `The suite "${name}" is required (FDW_REQUIRE_SUITES) but cannot run${
        reason ? `: ${reason}` : ''
      }`,
    );
  }
  return false;
}

/**
 * Whether windows can be opened: always on Windows and macOS, under X11 or
 * Wayland on Linux (Xvfb in the CI).
 */
export function hasDisplay(): boolean {
  const process = (
    globalThis as {
      process?: { platform: string; env: Record<string, string | undefined> };
    }
  ).process;
  if (!process) return false;
  return (
    process.platform === 'win32' ||
    process.platform === 'darwin' ||
    !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'])
  );
}
