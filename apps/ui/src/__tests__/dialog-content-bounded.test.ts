import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

// Companion to `no-raw-vh-units.test.ts`. That guard catches the WRONG unit
// (`vh` instead of `dvh`/`svh`); this one catches a MISSING bound, which the
// unit guard structurally cannot see — an absent `max-h` matches no regex.
//
// Why it matters: `DialogContent` is `fixed top-[50%] translate-y-[-50%]` with
// no max-height and no overflow of its own (see `components/ui/dialog.tsx`), so
// content taller than the viewport clips at both ends and cannot be scrolled to.
// On a non-dismissible dialog that is a trap rather than a cosmetic bug — which
// is exactly how the U18 guardian flow regressed.
//
// The fix is normally to use `ResponsiveDialog`, which supplies
// `max-h-[90dvh] overflow-hidden` on both the Dialog and Drawer shapes. A raw
// `DialogContent` is still allowed, but it must bound its own height.

// The primitive itself and the wrapper that supplies the bound.
const EXEMPT = ['components/ui/dialog.tsx', 'components/ui/responsive-dialog.tsx'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') return [];
      return walk(p);
    }
    return p.endsWith('.tsx') ? [p] : [];
  });
}

/**
 * Returns the attribute text of every `<DialogContent ...>` opening tag.
 *
 * A naive `/<DialogContent([^>]*)>/` breaks on props containing `>` — e.g.
 * `onInteractOutside={(e) => e.preventDefault()}` — so track brace depth and
 * stop at the first `>` that sits outside a `{...}` expression.
 */
function dialogContentTags(text: string): string[] {
  const tags: string[] = [];
  const OPEN = '<DialogContent';

  for (let i = text.indexOf(OPEN); i !== -1; i = text.indexOf(OPEN, i + 1)) {
    // Skip `<DialogContentSomethingElse`.
    const after = text[i + OPEN.length];
    if (after && /[A-Za-z0-9_]/.test(after)) continue;

    let depth = 0;
    for (let j = i + OPEN.length; j < text.length; j++) {
      const ch = text[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) {
        tags.push(text.slice(i, j + 1));
        break;
      }
    }
  }
  return tags;
}

describe('every DialogContent bounds its height', () => {
  it('uses ResponsiveDialog or declares an explicit max-h', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (EXEMPT.includes(rel.split('\\').join('/'))) continue;

      const text = readFileSync(file, 'utf8');
      for (const tag of dialogContentTags(text)) {
        if (!/max-h-\[/.test(tag)) {
          offenders.push(`${rel}  ${tag.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }

    expect(
      offenders,
      `DialogContent without a height bound (use ResponsiveDialog, or add max-h-[90dvh] plus overflow-y-auto):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
