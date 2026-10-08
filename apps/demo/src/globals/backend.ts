export type BackendName = 'webgpu' | 'webgl2';

export const backendLabels: Record<BackendName, string> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
};

const storageKey = 'fdw-engine:backend';

const isBackendName = (value: unknown): value is BackendName =>
  value === 'webgpu' || value === 'webgl2';

// The backend of the demo: ?backend=webgl2 in the URL, else the last choice,
// else WebGPU where available and WebGL2 elsewhere.
export function getBackendName(): BackendName {
  const requested = new URLSearchParams(window.location.search).get('backend');
  if (isBackendName(requested)) {
    window.localStorage.setItem(storageKey, requested);
    return requested;
  }
  const stored = window.localStorage.getItem(storageKey);
  if (isBackendName(stored)) {
    return stored;
  }
  return 'gpu' in navigator ? 'webgpu' : 'webgl2';
}

// The engine is created once per page: switching reloads it.
export function switchBackend(name: BackendName): void {
  window.localStorage.setItem(storageKey, name);
  const url = new URL(window.location.href);
  url.searchParams.delete('backend');
  window.location.assign(url);
}
