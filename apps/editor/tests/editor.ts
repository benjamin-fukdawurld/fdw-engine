// The editor started for a test, and the X server it runs in: xprobe
// (xprobe.c) gives the inputs and reads the pixels of the screen.
import {
  _electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  execFileSync,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const editorRoot = join(__dirname, '..');
const electron = join(editorRoot, 'node_modules/electron/dist/electron');

export type Color = readonly [number, number, number];

// Built at the first use, next to its source, when older.
function xprobePath(): string {
  const source = join(__dirname, 'xprobe.c');
  const binary = join(editorRoot, 'build/xprobe');
  if (
    !existsSync(binary) ||
    statSync(binary).mtimeMs < statSync(source).mtimeMs
  ) {
    execFileSync('cc', ['-O1', '-o', binary, source, '-lX11', '-ldl']);
  }
  return binary;
}

/** The X server, through xprobe: one command, one answer. */
export class XServer {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #lines: Interface;
  #queue = Promise.resolve('');

  constructor() {
    this.#child = spawn(xprobePath(), [], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.#lines = createInterface({ input: this.#child.stdout });
  }

  #send(command: string): Promise<string> {
    const next = this.#queue.then(
      () =>
        new Promise<string>((resolve, reject) => {
          this.#lines.once('line', (line) =>
            line.startsWith('error')
              ? reject(new Error(`xprobe ${command}: ${line}`))
              : resolve(line),
          );
          this.#child.stdin.write(`${command}\n`);
        }),
    );
    this.#queue = next.catch(() => '');
    return next;
  }

  async move(x: number, y: number): Promise<void> {
    await this.#send(`move ${Math.round(x)} ${Math.round(y)}`);
    await this.#send('sync');
  }

  async button(button: number, state: 'down' | 'up'): Promise<void> {
    await this.#send(`button ${button} ${state}`);
    await this.#send('sync');
  }

  async click(x: number, y: number, button = 1): Promise<void> {
    await this.move(x, y);
    await this.button(button, 'down');
    await this.button(button, 'up');
  }

  /** A key, by its X name (a, Delete, Escape…). */
  async press(key: string): Promise<void> {
    await this.#send(`key ${key} down`);
    await this.#send(`key ${key} up`);
    await this.#send('sync');
  }

  async pixel(x: number, y: number): Promise<Color> {
    return parseColor(
      await this.#send(`pixel ${Math.round(x)} ${Math.round(y)}`),
    );
  }

  /** The mean color of a rectangle of the screen. */
  async region(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<Color> {
    const rounded = [x, y, width, height].map(Math.round).join(' ');
    return parseColor(await this.#send(`region ${rounded}`));
  }

  close(): void {
    this.#child.stdin.end();
  }
}

function parseColor(line: string): Color {
  const [r = 0, g = 0, b = 0] = line.split(' ').map(Number);
  return [r, g, b];
}

/** A rectangle in pixels of the screen. */
export interface ScreenBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface Editor {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly x: XServer;
  /** The text of the status bar once the engine draws frames. */
  drawing(): Promise<string>;
  /** The area of the viewport on the screen, in device pixels. */
  viewportArea(): Promise<ScreenBox>;
  screenBox(locator: Locator): Promise<ScreenBox>;
  /** The color the page has at a point of the screen, under the viewport. */
  pageColor(x: number, y: number): Promise<Color>;
  /** Whether the screen shows something else than the page there. */
  differsFromPage(x: number, y: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Starts the editor in the X server of $DISPLAY, with a user data of its
 * own (the default layout); `env` adds to its environment.
 */
export async function startEditor(
  env: Record<string, string> = {},
): Promise<Editor> {
  const userData = mkdtempSync(join(tmpdir(), 'fdw-editor-'));
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  // Set by the terminals of VS Code: Electron would start as Node.
  delete environment['ELECTRON_RUN_AS_NODE'];
  const app = await _electron.launch({
    executablePath: electron,
    // The runners of the CI do not give Chromium its sandbox.
    args: process.env['CI'] ? [editorRoot, '--no-sandbox'] : [editorRoot],
    cwd: editorRoot,
    env: {
      ...environment,
      FDW_USER_DATA: userData,
      // The Dawn process needs Node 24: the one running the tests.
      FDW_NODE: process.execPath,
      ...env,
    },
  });
  const page = await app.firstWindow();
  const x = new XServer();

  const scale = () => page.evaluate(() => window.devicePixelRatio);
  // The origin of the page on the screen: there is no window manager in
  // the X server of the tests, the content bounds are the window's.
  const origin = () =>
    app.evaluate(({ BrowserWindow }) => {
      const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds() ?? {
        x: 0,
        y: 0,
      };
      return { x: bounds.x, y: bounds.y };
    });
  const screenBox = async (locator: Locator): Promise<ScreenBox> => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Not visible');
    const [ratio, at] = await Promise.all([scale(), origin()]);
    const left = Math.round(at.x * ratio + box.x * ratio);
    const top = Math.round(at.y * ratio + box.y * ratio);
    const width = Math.round(box.width * ratio);
    const height = Math.round(box.height * ratio);
    return {
      x: left,
      y: top,
      width,
      height,
      centerX: left + Math.floor(width / 2),
      centerY: top + Math.floor(height / 2),
    };
  };
  const pageColor = async (
    screenX: number,
    screenY: number,
  ): Promise<Color> => {
    const [ratio, at] = await Promise.all([scale(), origin()]);
    return page.evaluate(
      ({ x, y }) => {
        // The first background that is not transparent, up the tree.
        let element = document.elementFromPoint(x, y);
        let color = 'rgb(0, 0, 0)';
        while (element) {
          const background = getComputedStyle(element).backgroundColor;
          if (
            background !== 'rgba(0, 0, 0, 0)' &&
            background !== 'transparent'
          ) {
            color = background;
            break;
          }
          element = element.parentElement;
        }
        // In sRGB, whatever its syntax (oklch for the theme).
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        if (!context) return [0, 0, 0] as const;
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
        return [r, g, b] as const;
      },
      { x: screenX / ratio - at.x, y: screenY / ratio - at.y },
    );
  };

  return {
    app,
    page,
    x,
    drawing: async () => {
      const footer = page.locator('footer');
      await expect(footer).toContainText(/ [1-9]\d* fps/, { timeout: 30_000 });
      return footer.innerText();
    },
    viewportArea: () => screenBox(page.getByTestId('viewport')),
    screenBox,
    pageColor,
    differsFromPage: async (screenX, screenY) => {
      const [shown, behind] = await Promise.all([
        x.region(screenX - 2, screenY - 2, 5, 5),
        pageColor(screenX, screenY),
      ]);
      return shown.some((value, i) => Math.abs(value - (behind[i] ?? 0)) > 12);
    },
    close: async () => {
      x.close();
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
