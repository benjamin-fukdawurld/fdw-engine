// The developer documentation of FdwEngine: Astro + Starlight, in English
// (default) and French, with live examples and the API reference generated
// from the TSDoc comments of the packages.
import { fileURLToPath } from 'node:url';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

const root = fileURLToPath(new URL('../..', import.meta.url));

// The packages of the API reference.
const packages = [
  'engine-core',
  'engine-geometry',
  'engine-scene',
  'engine-shader',
  'engine-backend',
  'engine-webgpu',
  'engine-webgl2',
  'engine-native',
  'engine-vulkan',
];

// The sidebar group of the API reference. starlight-typedoc replaces its
// placeholder with a group of its own, without translations: this plugin,
// run after it, adds them.
const apiLabel = 'API reference';
const apiLabelTranslations = {
  name: 'fdw-api-label-translations',
  hooks: {
    'config:setup'({ config, updateConfig }) {
      updateConfig({
        sidebar: config.sidebar?.map((item) =>
          item.label === apiLabel
            ? { ...item, translations: { fr: 'Référence API' } }
            : item
        ),
      });
    },
  },
};

export default defineConfig({
  site: 'https://benjamin-fukdawurld.github.io',
  base: '/fdw-engine',
  integrations: [
    starlight({
      title: 'FdwEngine',
      description:
        'A multi-backend 3D engine in TypeScript: material graphs, render graph, compute, WebGPU, WebGL2 and Vulkan.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        fr: { label: 'Français', lang: 'fr' },
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/benjamin-fukdawurld/fdw-engine',
        },
      ],
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightTypeDoc({
          entryPoints: packages.map(
            (name) => `${root}packages/${name}/src/index.ts`
          ),
          tsconfig: './tsconfig.typedoc.json',
          output: 'api',
          sidebar: { label: apiLabel, collapsed: true },
          typeDoc: {
            excludePrivate: true,
            excludeInternal: true,
            skipErrorChecking: true,
          },
        }),
        apiLabelTranslations,
      ],
      sidebar: [
        {
          label: 'Getting started',
          translations: { fr: 'Prise en main' },
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Tutorials',
          translations: { fr: 'Tutoriels' },
          items: [{ autogenerate: { directory: 'tutorials' } }],
        },
        {
          label: 'Making a game',
          translations: { fr: 'Créer un jeu' },
          items: [{ autogenerate: { directory: 'game' } }],
        },
        {
          label: 'Guides',
          translations: { fr: 'Guides' },
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Contributing',
          translations: { fr: 'Contribuer' },
          items: [{ autogenerate: { directory: 'contributing' } }],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
  vite: {
    // The examples import the sources of the packages of the monorepo.
    server: { fs: { allow: [root] } },
  },
});
