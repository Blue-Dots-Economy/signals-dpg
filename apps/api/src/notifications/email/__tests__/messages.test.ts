import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiredMessageKeys } from '../email_cases';

// notification.EMAIL_MESSAGES_PATH is read once, at import time, by the
// `@/config` module. vi.hoisted + vi.mock let us swap its value per test
// without re-importing the whole config/env-parsing stack.
const mockNotification = vi.hoisted(() => ({
  EMAIL_MESSAGES_PATH: undefined as string | undefined,
}));

vi.mock('@/config', () => ({ notification: mockNotification }));

import {
  getEmailMessages,
  loadEmailMessages,
  resetEmailMessagesForTests,
} from '../messages';

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

describe('getEmailMessages (singleton + EMAIL_MESSAGES_PATH wiring)', () => {
  beforeEach(() => {
    resetEmailMessagesForTests();
    mockNotification.EMAIL_MESSAGES_PATH = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetEmailMessagesForTests();
  });

  it('serves bundled defaults and warns nothing when no override path is set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const m = await getEmailMessages();

    expect(m.get('welcome.subject')).toBe('Welcome!');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns (with the path) and falls back to bundled defaults when the override file is unreadable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badPath = '/no/such/path/messages.override.properties';
    mockNotification.EMAIL_MESSAGES_PATH = badPath;

    const m = await getEmailMessages();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(badPath));
    expect(m.get('welcome.subject')).toBe('Welcome!');
  });

  it('reuses the same instance across calls (singleton) without re-reading', async () => {
    const p1 = getEmailMessages();
    const p2 = getEmailMessages();
    expect(p1).toBe(p2);

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toBe(m2);
  });

  it('resetEmailMessagesForTests() clears the singleton so the next call re-loads', async () => {
    const m1 = await getEmailMessages();
    resetEmailMessagesForTests();
    const m2 = await getEmailMessages();
    expect(m1).not.toBe(m2);
  });
});
