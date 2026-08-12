import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMAIL_CASE_IDS, getEmailCase, requiredMessageKeys } from '../email_cases';
import { parseProperties } from '../parse_properties';

const TEXT = readFileSync(
  new URL('../messages.default.properties', import.meta.url),
  'utf8',
);

describe('messages.default.properties', () => {
  const { entries, malformedLines } = parseProperties(TEXT);

  it('parses with no malformed lines', () => {
    expect(malformedLines).toEqual([]);
  });

  it('defines every key the registry requires', () => {
    const missing = requiredMessageKeys().filter((k) => !entries.has(k));
    expect(missing).toEqual([]);
  });

  it('has no keys the registry does not know (catches typos both ways)', () => {
    const known = new Set(requiredMessageKeys());
    const unknown = [...entries.keys()].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('only references tokens declared for each case', () => {
    const offenders: string[] = [];
    for (const id of EMAIL_CASE_IDS) {
      const def = getEmailCase(id);
      for (const key of [def.keys.subject, def.keys.body, def.keys.cta].filter(
        (k): k is string => Boolean(k),
      )) {
        const value = entries.get(key) ?? '';
        for (const m of value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) {
          // Object.hasOwn, not `in`: `in` would treat {{toString}}/
          // {{constructor}} as declared via the prototype chain.
          if (!Object.hasOwn(def.tokens, m[1])) offenders.push(`${key} -> {{${m[1]}}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps a spot-checked string verbatim from the old copy table', () => {
    expect(entries.get('action.connect.seeker.inbound_request.subject')).toBe(
      'A service provider wants to connect with you',
    );
    expect(entries.get('action.apply.seeker.inbound_request.subject')).toBe(
      '{{name}} has shown interest in your profile',
    );
    // Provider-facing copy keeps the seeker generic (no {{name}} token).
    expect(entries.get('action.connect.provider.inbound_request.subject')).toBe(
      'A seeker wants to avail your service',
    );
    expect(entries.get('action.apply.provider.inbound_request.subject')).toBe(
      'A seeker has applied for your opportunity',
    );
    // Seeker-facing "apply" copy uses the {{name}} token.
    expect(entries.get('action.apply.seeker.outbound_request.subject')).toBe(
      'Your application has been sent to {{name}}',
    );
    // Pins the support subject template (#529 migration) — a typo dropping
    // {{type}} or {{fromSite}} here would otherwise pass the suite silently,
    // since the substitution mechanics are only tested with fake templates.
    expect(entries.get('support.request.subject')).toBe(
      'Issue Number: {{reference}} — {{type}} from {{name}}{{fromSite}}',
    );
  });
});
