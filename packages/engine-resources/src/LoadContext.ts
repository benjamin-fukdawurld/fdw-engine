import type { ResourceHandle } from './ResourceHandle';
import type {
  ResourceBytes,
  ResourceType,
  ResourceUri,
  ServiceKey,
} from './types';

export interface LoadContext<O> {
  readonly uri: ResourceUri;
  readonly options: O;
  // Aborted when nobody waits for the result any more. Pass it to fetch and
  // decoders, and check it between the steps.
  readonly signal: AbortSignal;

  /** The bytes of the resource. Read once: every call returns the same array. */
  bytes(): Promise<ResourceBytes>;
  text(): Promise<string>;
  // Resolves a path relative to this resource (a glTF and its textures).
  resolve(relative: string): ResourceUri;

  // Loads another resource this one depends on. The handle is owned by this
  // entry: it is released with it, and a change of the dependency reloads or
  // updates this one (§6.7). Progress is aggregated into this one's.
  use<U, P = void>(
    type: ResourceType<U>,
    uri: ResourceUri,
    options?: P,
  ): ResourceHandle<U>;
  // Registers a sub-resource, addressable as `uri#id`, owned by this entry.
  provide<U>(type: ResourceType<U>, id: string, value: U): ResourceHandle<U>;
  // A service of the store: the render backend, the audio device…
  service<S>(key: ServiceKey<S>): S;

  progress(loaded: number, total?: number): void;
}
