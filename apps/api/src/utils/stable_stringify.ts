/**
 * Deterministic stringify for cache keys: objects are serialized with keys
 * sorted, so two equal filter objects always produce the same string
 * regardless of property insertion order. Shared by the local and
 * inter-instance item-fetch cache-key builders.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
