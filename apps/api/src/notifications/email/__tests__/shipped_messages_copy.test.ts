/**
 * Structural checks on the shipped per-network copy in `examples/schemas/*`.
 *
 * These files are transcribed by hand from the content team's sheet, so the
 * failure mode is a copy-shaped mistake rather than a code bug — and it is only
 * visible in a rendered email, which no other test looks at. Two rules, both
 * from defects seen in real mail:
 *
 *  1. The sign-off belongs after the OTP, not before it. The sheet's guardian
 *     cells put "- Team EkStep:" immediately ahead of the code, so the mail read
 *     "...Use the given OTP... - Team EkStep: 868974"; every other template in
 *     the same sheet signs off last.
 *  2. Copy must use the `{{siteLink}}` token rather than hand-rolling
 *     `<a href="{{siteUrl}}">`, so links pick up the inline styling that mail
 *     clients need in order to show them as links at all.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EMAIL_CASE_IDS, getEmailCase } from '../email_cases';
import { TOKEN_RE } from '../substitute';

const SCHEMAS_DIR = path.resolve(import.meta.dirname, '../../../../../../examples/schemas');

/** Every shipped messages.properties, network- and brand-level. */
function messageFiles(): string[] {
  if (!existsSync(SCHEMAS_DIR)) return [];
  const found: string[] = [];
  for (const network of readdirSync(SCHEMAS_DIR, { withFileTypes: true })) {
    if (!network.isDirectory()) continue;
    const networkDir = path.join(SCHEMAS_DIR, network.name);
    for (const entry of readdirSync(networkDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === 'messages.properties') {
        found.push(path.join(networkDir, entry.name));
      }
      if (entry.isDirectory()) {
        const brandFile = path.join(networkDir, entry.name, 'messages.properties');
        if (existsSync(brandFile)) found.push(brandFile);
      }
    }
  }
  return found;
}

/** `key=value` lines, comments and blanks dropped. */
function entries(file: string): Array<[string, string]> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#') && line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1)] as [string, string];
    });
}

const files = messageFiles();

describe('shipped per-network email copy', () => {
  it('finds the example messages files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never places the sign-off before the OTP box', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [key, value] of entries(file)) {
        if (/Team [^<:]*:?<\/p>\s*\{\{otpBox\}\}/.test(value)) {
          offenders.push(`${path.relative(SCHEMAS_DIR, file)} → ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses the {{siteLink}} token instead of a hand-rolled anchor', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const [key, value] of entries(file)) {
        if (/<a\s+href="\{\{\w+\}\}"/.test(value)) {
          offenders.push(`${path.relative(SCHEMAS_DIR, file)} → ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only uses tokens the corresponding case declares', () => {
    // An undeclared token is left verbatim by the substituter, so a typo or a
    // token borrowed from another case ships `{{like_this}}` to a real inbox.
    const offenders: string[] = [];
    for (const file of files) {
      for (const [key, value] of entries(file)) {
        const caseId = key.replace(/\.(subject|body|cta)$/, '');
        if (!EMAIL_CASE_IDS.includes(caseId)) {
          offenders.push(`${path.relative(SCHEMAS_DIR, file)} → ${key} (no such case)`);
          continue;
        }
        const declared = getEmailCase(caseId).tokens;
        for (const [, name] of value.matchAll(TOKEN_RE)) {
          if (!Object.hasOwn(declared, name)) {
            offenders.push(`${path.relative(SCHEMAS_DIR, file)} → ${key} uses {{${name}}}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
