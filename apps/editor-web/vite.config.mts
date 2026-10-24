/// <reference types='vitest' />
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { playwright } from '@vitest/browser-playwright';

// The models of the TPS scene live with those of the documentation: served
// under /models/forest/ while developing, copied into the build.
const forest = resolve(import.meta.dirname, '../docs/public/models/forest');
const types: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.png': 'image/png',
};
function forestModels(): Plugin {
  return {
    name: 'forest-models',
    configureServer(server) {
      server.middlewares.use('/models/forest', (request, response, next) => {
        const file = join(
          forest,
          decodeURIComponent((request.url ?? '').split('?')[0]),
        );
        if (
          !file.startsWith(forest) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          next();
          return;
        }
        response.setHeader(
          'Content-Type',
          types[extname(file)] ?? 'application/octet-stream',
        );
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      cpSync(forest, resolve(import.meta.dirname, 'dist/models/forest'), {
        recursive: true,
      });
    },
  };
}

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/editor-web',
  // FDW_BACKEND and FDW_SCENE, read at the build and by the dev server
  // (design/editor-ui.md §4).
  envPrefix: ['VITE_', 'FDW_'],
  server: {
    port: 4300,
    host: 'localhost',
  },
  preview: {
    port: 4300,
    host: 'localhost',
  },
  plugins: [react(), tailwindcss(), forestModels()],
  // @fdw/editor-ui has React as a peer: one copy for the page.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    rollupOptions: {
      // The empty page of the popouts (EditorHost.popoutUrl).
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        popout: resolve(import.meta.dirname, 'popout.html'),
      },
    },
  },
  // The editor in Chromium, on both backends: WebGPU and WebGL2 on
  // SwiftShader, without a GPU (CI, headless servers).
  test: {
    name: 'editor-web',
    watch: false,
    include: ['src/**/*.spec.{ts,tsx}'],
    reporters: ['default'],
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            // WebGPU on SwiftShader by Vulkan, as the tests of the
            // documentation: on the default adapter, the readbacks of the
            // picking never resolve.
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
            '--use-webgpu-adapter=swiftshader',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ],
        },
      }),
      instances: [
        { browser: 'chromium' as const, viewport: { width: 960, height: 540 } },
      ],
    },
  },
}));
