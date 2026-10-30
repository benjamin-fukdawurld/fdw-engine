// The end-to-end tests of the editor (tests/editor.spec.ts): in an X server
// of their own under Linux (xvfb-run), on the desktop elsewhere.
import { spawnSync } from 'node:child_process';

const playwright = ['npx', 'playwright', 'test', ...process.argv.slice(2)];
const [command, ...args] =
  process.platform === 'linux'
    ? ['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', ...playwright]
    : playwright;
const { status, error } = spawnSync(command, args, {
  stdio: 'inherit',
  // npx is a script under Windows.
  shell: process.platform === 'win32',
});
if (error) throw error;
process.exit(status ?? 1);
