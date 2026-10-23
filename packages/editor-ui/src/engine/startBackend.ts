/** A rendering backend a host can start: Vulkan, Dawn, WebGPU, WebGL2. */
export interface BackendCandidate<T> {
  /** The value of FDW_BACKEND that asks for it. */
  readonly name: string;
  /** Starts it; throws when it cannot (no addon, no device, no surface). */
  start(): Promise<T>;
}

/** The backend that started, and why it is not the one asked for. */
export interface StartedBackend<T> {
  readonly name: string;
  readonly value: T;
  /** The reason of a fallback; undefined when the backend asked for runs. */
  readonly fallback?: string;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Starts the backend asked for by FDW_BACKEND (design/editor-ui.md §4):
 * the preferred one without the variable, the fallback when the one asked
 * for does not start or is unknown. The fallback failing too throws.
 */
export async function startBackend<T>(
  requested: string | undefined,
  preferred: BackendCandidate<T>,
  fallback: BackendCandidate<T>,
): Promise<StartedBackend<T>> {
  const name = requested || preferred.name;
  if (name === fallback.name) {
    return { name, value: await fallback.start() };
  }
  let reason: string;
  if (name === preferred.name) {
    try {
      return { name, value: await preferred.start() };
    } catch (error) {
      reason = `${name}: ${errorText(error)}`;
    }
  } else {
    reason = `Unknown backend ${name}`;
  }
  return {
    name: fallback.name,
    value: await fallback.start(),
    fallback: reason,
  };
}
