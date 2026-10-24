/// <reference types="vite/client" />

// The variables of the environment given to the page (envPrefix).
interface ImportMetaEnv {
  readonly FDW_BACKEND?: string;
  readonly FDW_SCENE?: string;
  // Where the models of the forest are served, when not by the application
  // (the documentation serves its own).
  readonly FDW_MODELS?: string;
}
