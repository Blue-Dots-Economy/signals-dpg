import { describe, it, expect, vi, beforeEach } from 'vitest';

// #626: an acceptance made at the (always-adult) pre-login gate must not be
// recorded for a known minor on a network that ships a U18 document set.

let variant: 'adult' | 'u18' | undefined = 'adult';
let entries: Array<{ brand: string | null; schema: Record<string, unknown> }> = [];
let fail = false;
vi.mock('@/lib/consent-api', () => ({
  getConsentStatus: async () => {
    if (fail) throw new Error('down');
    return { statuses: { terms: [], privacy: [] }, variant };
  },
  fetchConsentConfigs: async () => entries,
}));

const { preLoginConsentApplies } = await import('../pre-login-consent');

const doc = { current_version: 2, versions: [] };
const docs = { terms: doc, privacy: doc, profile_creation: doc };
const withU18 = { documents: docs, u18_documents: { ...docs, guardian_declaration: doc } };
const adultOnly = { documents: docs };

beforeEach(() => {
  variant = 'adult';
  entries = [{ brand: null, schema: withU18 }];
  fail = false;
});

describe('preLoginConsentApplies', () => {
  it('records an adult’s pre-login acceptance', async () => {
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(true);
  });

  it('records it when the status carries no variant (older API)', async () => {
    variant = undefined;
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(true);
  });

  it('drops a known minor’s acceptance where a U18 set exists — they read the adult text', async () => {
    variant = 'u18';
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(false);
  });

  it('keeps a minor’s acceptance where the network ships no U18 set — the adult text is theirs', async () => {
    variant = 'u18';
    entries = [{ brand: null, schema: adultOnly }];
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(true);
  });

  it('honours a brand that introduces a U18 set the network lacks', async () => {
    variant = 'u18';
    entries = [
      { brand: null, schema: adultOnly },
      { brand: 'acme', schema: withU18 },
    ];
    expect(await preLoginConsentApplies('blue_dot', 'acme')).toBe(false);
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(true);
  });

  it('records nothing when the check itself fails', async () => {
    fail = true;
    expect(await preLoginConsentApplies('blue_dot', null)).toBe(false);
  });
});
