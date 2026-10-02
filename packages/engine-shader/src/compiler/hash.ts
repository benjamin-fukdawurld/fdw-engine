// 64-bit FNV-1a hash, as 16 hex digits. Used for cache keys, not security.
export function hashString(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

// JSON with sorted object keys: equal values give equal strings.
export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))
        )
      : inner
  );
