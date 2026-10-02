import { Signal } from '@preact/signals-core';
import type { RenderBackend } from './render';

export const EngineStateNames = [
  'uninitialized',
  'initializing',
  'ready',
  'paused',
  'destroying',
  'destroyed',
] as const;
export type EngineState = (typeof EngineStateNames)[number];

export interface Engine extends EventTarget {
  state: Signal<EngineState>;
  // Available once the engine is ready.
  readonly backend: RenderBackend | undefined;
  init(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}
