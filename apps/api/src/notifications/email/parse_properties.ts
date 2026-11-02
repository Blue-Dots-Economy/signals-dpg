/**
 * Minimal Java-properties-style parser: `key=value` per line, `#`/`!`
 * comments, split at the first `=` (values are HTML and may contain `=`), no
 * escapes, no line continuation.
 */
export interface ParsedProperties {
  entries: Map<string, string>;
  /** 1-based line numbers that were neither blank/comment nor `key=value`. */
  malformedLines: number[];
}

export function parseProperties(text: string): ParsedProperties {
  const entries = new Map<string, string>();
  const malformedLines: number[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) {
      malformedLines.push(i + 1);
      continue;
    }
    entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  return { entries, malformedLines };
}
