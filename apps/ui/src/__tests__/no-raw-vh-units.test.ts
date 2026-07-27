import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
// Bare vh is banned in favour of dvh/svh. dvh/svh themselves contain "vh" as a
// substring, so match a digit or "(" immediately before "vh" but NOT "d"/"s".
const BANNED = /(?<![ds])\d(?:vh)\b|min-h-screen|(?<![a-z-])h-screen\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') return [];
      return walk(p);
    }
    // Skip home-page.tsx as it is owned by PR #295
    if (p.endsWith('home-page.tsx')) return [];
    return p.endsWith('.tsx') || p.endsWith('.ts') ? [p] : [];
  });
}

describe('no raw vh units in apps/ui/src', () => {
  it('uses dvh/svh instead of vh/screen for viewport sizing', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (BANNED.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Raw vh/screen units found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
