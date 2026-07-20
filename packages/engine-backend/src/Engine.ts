import { Signal } from '@preact/signals-core';

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
  init(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
}
