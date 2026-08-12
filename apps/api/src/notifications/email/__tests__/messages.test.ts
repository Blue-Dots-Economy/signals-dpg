import { describe, expect, it, vi } from 'vitest';
import { loadEmailMessages } from '../messages';
import { requiredMessageKeys } from '../email_cases';

/** Minimal valid defaults: every required key present. */
function fullDefaults(): string {
  return requiredMessageKeys()
    .map((k) => `${k}=default ${k}`)
    .join('\n');
}

describe('loadEmailMessages', () => {
  it('throws at load when the bundled defaults are incomplete', () => {
    expect(() => loadEmailMessages({ defaultsText: 'welcome.subject=x' })).toThrow(
      /bundled email messages file is missing/,
    );
  });

  it('serves defaults when no override is given', () => {
    const m = loadEmailMessages({ defaultsText: fullDefaults() });
    expect(m.get('welcome.subject')).toBe('default welcome.subject');
  });

  it('merges per-key: override wins, everything else falls back', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcome.subject=Custom hello!',
      warn,
    });
    expect(m.get('welcome.subject')).toBe('Custom hello!');
    expect(m.get('welcome.body')).toBe('default welcome.body');
  });

  it('warns about unknown override keys (typo catcher)', () => {
    const warn = vi.fn();
    loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcom.subject=typo',
      warn,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('welcom.subject'));
  });

  it('warns about undeclared placeholders but keeps the value as written', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'welcome.body=<p>{{otpp}}</p>',
      warn,
    });
    expect(m.get('welcome.body')).toBe('<p>{{otpp}}</p>');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{otpp}}'));
  });

  it('warns about malformed override lines and ignores them', () => {
    const warn = vi.fn();
    const m = loadEmailMessages({
      defaultsText: fullDefaults(),
      overrideText: 'this line has no equals\nwelcome.subject=ok',
      warn,
    });
    expect(m.get('welcome.subject')).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('line 1'));
  });

  it('get() throws for unknown keys', () => {
    const m = loadEmailMessages({ defaultsText: fullDefaults() });
    expect(() => m.get('nope.nope')).toThrow('unknown email message key: nope.nope');
  });
});
