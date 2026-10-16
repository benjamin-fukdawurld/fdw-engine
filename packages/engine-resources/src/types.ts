import type { ReadonlySignal } from '@preact/signals-core';

// Phantom brands: they exist only in the type system, so they are declared,
// not created.
export declare const resourceTypeBrand: unique symbol;
export declare const serviceKeyBrand: unique symbol;

/** A typed token identifying a kind of resource, like `defineComponent`. */
export interface ResourceType<T> {
  readonly name: string;
  readonly [resourceTypeBrand]?: T;
}

export const defineResourceType = <T>(name: string): ResourceType<T> => ({
  name,
});

/** `scheme:path#fragment`. Without a scheme, the default scheme is used. */
export type ResourceUri = string;

/** A typed key for a service of the store (the render backend, the audio device…). */
export interface ServiceKey<S> {
  readonly name: string;
  readonly id: symbol;
  readonly [serviceKeyBrand]?: (service: S) => S;
}

export const defineServiceKey = <S>(name: string): ServiceKey<S> => ({
  name,
  id: Symbol(name),
});

/** Aggregated progress, for a loading screen. */
export interface LoadGroup {
  readonly progress: ReadonlySignal<number>;
  readonly pending: ReadonlySignal<number>;
  readonly ready: Promise<void>; // rejects with the first failure
}

export type ResourceBytes = Uint8Array<ArrayBuffer>;

/**
 * The bytes of a sub-resource (an image embedded in a GLB), provided by the
 * loader of its parent with `ctx.provide(ResourceBytesType, 'image/0', bytes)`.
 * `ctx.bytes()` of `model.glb#image/0` reads them instead of the file.
 */
export const ResourceBytesType = defineResourceType<ResourceBytes>('bytes');
