/**
 * Minimal Java-properties-style parser for the email messages file (#529).
 * Deliberately tiny: `key=value` per line, `#`/`!` comments, split at the
 * first `=`, no escape sequences, no line continuation. Values are HTML
 * fragments and may contain further `=` characters.
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
