import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Redis parking lot for signup fields that have nowhere to live until the
 * account exists. Two properties matter: the raw identifier never appears in a
 * key, and a stash can only be applied once.
 */

const store = new Map<string, string>();
const calls: string[] = [];

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    set: async (key: string, value: string) => {
      calls.push(`set ${key}`);
      store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => {
      calls.push(`get ${key}`);
      return store.get(key) ?? null;
    },
    del: async (key: string) => {
      calls.push(`del ${key}`);
      return store.delete(key) ? 1 : 0;
    },
  },
}));

const { stashSignupExtras, takeSignupExtras } = await import('../signup_extras.js');

const EMAIL = 'asha@example.org';
const PHONE = '+919876500001';

beforeEach(() => {
  store.clear();
  calls.length = 0;
});

describe('stash / take round-trip', () => {
  it('parks and returns the extras for an email signup', async () => {
    await stashSignupExtras({ email: EMAIL }, { domain: 'seeker', age: 20 });

    expect(await takeSignupExtras({ email: EMAIL })).toEqual({
      domain: 'seeker',
      age: 20,
    });
  });

  it('parks and returns the extras for a phone signup', async () => {
    await stashSignupExtras({ phoneNumber: PHONE }, { domain: 'provider' });

    expect(await takeSignupExtras({ phoneNumber: PHONE })).toEqual({ domain: 'provider' });
  });

  it('is retrievable by either identifier when both were given', async () => {
    // A token may carry both even though signup used one.
    await stashSignupExtras({ email: EMAIL, phoneNumber: PHONE }, { domain: 'seeker' });

    expect(await takeSignupExtras({ phoneNumber: PHONE })).toEqual({ domain: 'seeker' });
  });

  it('normalises the email so casing and spacing still match', async () => {
    await stashSignupExtras({ email: '  Asha@Example.ORG ' }, { domain: 'seeker' });

    expect(await takeSignupExtras({ email: EMAIL })).toEqual({ domain: 'seeker' });
  });

  it('returns null when nothing is parked', async () => {
    expect(await takeSignupExtras({ email: EMAIL })).toBeNull();
  });

  it('returns null when no identifier is given', async () => {
    expect(await takeSignupExtras({})).toBeNull();
  });
});

describe('privacy + replay', () => {
  it('never puts the raw identifier in a Redis key', async () => {
    await stashSignupExtras({ email: EMAIL, phoneNumber: PHONE }, { domain: 'seeker' });

    for (const key of store.keys()) {
      expect(key).not.toContain(EMAIL);
      expect(key).not.toContain('asha');
      expect(key).not.toContain(PHONE);
      expect(key).not.toContain('9876500001');
      expect(key).toMatch(/^signup_extras:[0-9a-f]{64}$/);
    }
  });

  it('deletes on read, so a stash cannot be applied twice', async () => {
    await stashSignupExtras({ email: EMAIL }, { domain: 'seeker' });

    expect(await takeSignupExtras({ email: EMAIL })).toEqual({ domain: 'seeker' });
    expect(await takeSignupExtras({ email: EMAIL })).toBeNull();
  });

  it('clears BOTH identifiers on read, so the other copy cannot be reused', async () => {
    // Otherwise the phone-keyed copy could be applied to a second account.
    await stashSignupExtras({ email: EMAIL, phoneNumber: PHONE }, { domain: 'seeker' });

    await takeSignupExtras({ email: EMAIL });

    expect(await takeSignupExtras({ phoneNumber: PHONE })).toBeNull();
    expect(store.size).toBe(0);
  });
});

describe('edge cases', () => {
  it('writes nothing when there is nothing worth keeping', async () => {
    await stashSignupExtras({ email: EMAIL }, {});
    expect(store.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sets a TTL on every key', async () => {
    await stashSignupExtras({ email: EMAIL }, { domain: 'seeker' });
    // `set(key, value, 'EX', ttl)` — the stash must expire rather than linger.
    expect(calls.some((c) => c.startsWith('set '))).toBe(true);
  });

  it('returns null for a corrupt payload rather than throwing', async () => {
    await stashSignupExtras({ email: EMAIL }, { domain: 'seeker' });
    const [key] = [...store.keys()];
    store.set(key, 'not json');

    expect(await takeSignupExtras({ email: EMAIL })).toBeNull();
  });
});
