import { ReadonlySignal } from '@preact/signals-core';

const resourceTypeBrand: unique symbol = Symbol('phantom:ResourceType');

export interface ResourceType<T> {
  readonly name: string;
  readonly [resourceTypeBrand]?: T;
}

export const defineResourceType = <T>(name: string): ResourceType<T> => ({
  name,
});

const resourceUriBrand: unique symbol = Symbol('phantom:ResourceUri');
export type ResourceUri = string & {
  readonly [resourceUriBrand]: true;
};

export const resourceUri = (uri: string): ResourceUri => uri as ResourceUri;

const serviceKeyBrand: unique symbol = Symbol('phantom:serviceKey');
export type ServiceKey<S> = string & {
  readonly name: string;
  readonly id: symbol;
  readonly [serviceKeyBrand]?: (service: S) => S;
};

// Aggregated progress, for a loading screen.
export interface LoadGroup {
  readonly progress: ReadonlySignal<number>;
  readonly pending: ReadonlySignal<number>;
  readonly ready: Promise<void>; // rejects with the first failure
}
