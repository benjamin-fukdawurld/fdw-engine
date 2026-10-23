/// <reference types="vite/client" />

// The variables of the environment given to the page (envPrefix).
interface ImportMetaEnv {
  readonly FDW_BACKEND?: string;
  readonly FDW_SCENE?: string;
}
