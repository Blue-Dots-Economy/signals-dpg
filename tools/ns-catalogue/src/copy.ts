import { readFileSync } from 'node:fs';

import { requiredMessageKeys } from './legacy/email_cases';
import { parseProperties } from './legacy/parse_properties';

/** One copy file to merge, named for warnings (e.g. `network blue_dot`). */
export interface CopyLayer {
  label: string;
  text: string;
}

const DEFAULTS_URL = new URL('./legacy/messages.default.properties', import.meta.url);

/** The bundled default copy that ships with Signals today. */
export function readDefaultCopyText(): string {
  return readFileSync(DEFAULTS_URL, 'utf8');
}

/** Every copy key the case registry knows. */
export function knownCopyKeys(): Set<string> {
  return new Set(requiredMessageKeys());
}

/**
 * Merge copy per key, lowest layer first (F2-3: bundled defaults < network
 * file < brand file). Mirrors today's `mergeLayer` rules so the generator
 * layers copy exactly as Signals does: an unknown key, an empty value and a
 * malformed line are each ignored with a warning naming the layer.
 */
export function mergeCopy(
  defaultsText: string,
  layers: CopyLayer[],
): { copy: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  const known = knownCopyKeys();
  const defaults = parseProperties(defaultsText);
  const missing = [...known].filter((k) => !defaults.entries.has(k));
  if (missing.length > 0) {
    throw new Error(`bundled email messages file is missing required keys: ${missing.join(', ')}`);
  }
  const copy = new Map(defaults.entries);

  for (const layer of layers) {
    const parsed = parseProperties(layer.text);
    for (const line of parsed.malformedLines) {
      warnings.push(`copy ${layer.label}: line ${line} is not "key=value"; ignored`);
    }
    for (const [key, value] of parsed.entries) {
      if (!known.has(key)) {
        warnings.push(`copy ${layer.label}: unknown key "${key}"; ignored`);
        continue;
      }
      if (value === '') {
        warnings.push(`copy ${layer.label}: empty value for "${key}"; ignored (the lower layer applies)`);
        continue;
      }
      copy.set(key, value);
    }
  }
  return { copy, warnings };
}
