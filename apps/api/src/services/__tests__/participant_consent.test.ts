import { describe, it, expect, beforeEach, vi } from 'vitest';

const resolveConsentVersion = vi.fn();
const hasAcceptedTermsAndPrivacy = vi.fn();
const hasAcceptedProfileConsent = vi.fn();
const promoteItemOnProfileConsent = vi.fn();

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: unknown[]) => resolveConsentVersion(...a),
}));
vi.mock('@/services/consent_acceptance', () => ({
  hasAcceptedTermsAndPrivacy: (...a: unknown[]) => hasAcceptedTermsAndPrivacy(...a),
  hasAcceptedProfileConsent: (...a: unknown[]) => hasAcceptedProfileConsent(...a),
}));
vi.mock('@/services/item_service', () => ({
  promoteItemOnProfileConsent: (...a: unknown[]) => promoteItemOnProfileConsent(...a),
}));
vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { __table: 'consent_record' },
}));
vi.mock('@dpg/database', () => ({ items: { __table: 'items' } }));

import { recordParticipantConsent } from '@/services/participant_consent';

// helper to build a tx whose select().from().where() resolves to `draftRows`
function makeSelectTx(draftRows: Array<{ item_id: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => draftRows),
      })),
    })),
  };
}

type InsertedRow = Record<string, unknown>;

function makeTx() {
  const inserted: InsertedRow[] = [];
  const tx = {
    insert: vi.fn(() => ({
      // `values(row)` records the attempted row and returns a thenable that
      // ALSO exposes `.onConflictDoNothing()` — so plain `await values(row)`
      // (user-level terms/privacy) and the chained
      // `values(row).onConflictDoNothing(...)` (profile_creation) both work.
      values: vi.fn((row: InsertedRow) => {
        inserted.push(row);
        const promise = Promise.resolve();
        return Object.assign(promise, {
          onConflictDoNothing: () => Promise.resolve(),
        });
      }),
    })),
  };
  return { tx, inserted };
}

describe('recordParticipantConsent', () => {
  beforeEach(() => {
    resolveConsentVersion.mockReset();
    hasAcceptedTermsAndPrivacy.mockReset();
    hasAcceptedProfileConsent.mockReset();
    promoteItemOnProfileConsent.mockReset();
    resolveConsentVersion.mockResolvedValue(1);
    hasAcceptedTermsAndPrivacy.mockResolvedValue(true);
    hasAcceptedProfileConsent.mockResolvedValue(false);
    promoteItemOnProfileConsent.mockResolvedValue(true);
  });

  it('returns zero when compliance is absent', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res).toEqual({ recorded: 0, promoted: false });
    expect(inserted).toHaveLength(0);
  });

  it('records terms + privacy as user-level rows with source=signup and metadata', async () => {
    const { tx, inserted } = makeTx();
    const acceptedAt = new Date('2026-07-22T00:00:00.000Z');
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt,
    });
    expect(res.recorded).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      level: 'user', consentCategory: 'terms', userId: 'u1', network: 'blue_dot',
      documentVersion: 1, source: 'signup', acceptedAt,
      metadata: { channel: 'voice', via: 'admin_participant', key: 'user_terms' },
    });
    expect(inserted[1]).toMatchObject({ consentCategory: 'privacy', source: 'signup' });
  });

  it('skips value:false and unknown keys', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: false },
        { key: 'something_else', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'bulk', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('skips a category whose version is unconfigured', async () => {
    resolveConsentVersion.mockResolvedValue(null);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'user_terms', value: true }],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('does not promote when profile_creation version is unconfigured and nothing was recorded', async () => {
    resolveConsentVersion.mockResolvedValue(null);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'profile_creation', value: true }],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(res.promoted).toBe(false);
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalled();
    expect(inserted.find((r) => r.consentCategory === 'profile_creation')).toBeUndefined();
  });

  it('records profile_creation and promotes when prerequisites met and item present', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(3);
    expect(res.promoted).toBe(true);
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'item-1');
    const profileRow = inserted.find((r) => r.consentCategory === 'profile_creation');
    expect(profileRow).toMatchObject({
      level: 'item', itemId: 'item-1', source: 'profile',
      metadata: { channel: 'voice', via: 'admin_participant', key: 'profile_creation' },
    });
  });

  it('skips profile_creation when no item is present', async () => {
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(2);
    expect(res.promoted).toBe(false);
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalled();
    expect(inserted.find((r) => r.consentCategory === 'profile_creation')).toBeUndefined();
  });

  it('skips profile_creation when terms/privacy prerequisite is missing', async () => {
    hasAcceptedTermsAndPrivacy.mockResolvedValue(false);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'profile_creation', value: true }],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(res.promoted).toBe(false);
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('does not re-insert profile_creation when already recorded but still promotes', async () => {
    hasAcceptedProfileConsent.mockResolvedValue(true);
    const { tx, inserted } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [{ key: 'profile_creation', value: true }],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.recorded).toBe(0);
    expect(res.promoted).toBe(true);
    expect(inserted.find((r) => r.consentCategory === 'profile_creation')).toBeUndefined();
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'item-1');
  });

  it('reports promoted:false when the item does not go live (e.g. minor gate)', async () => {
    promoteItemOnProfileConsent.mockResolvedValue(false);
    const { tx } = makeTx();
    const res = await recordParticipantConsent(tx as never, {
      compliance: [
        { key: 'user_terms', value: true },
        { key: 'user_privacy', value: true },
        { key: 'profile_creation', value: true },
      ],
      userId: 'u1', itemId: 'item-1', network: 'blue_dot', channel: 'voice', acceptedAt: new Date(),
    });
    expect(res.promoted).toBe(false);
  });

  it('promoteEligibleDraftsForUser promotes only drafts that have profile_creation consent', async () => {
    hasAcceptedProfileConsent.mockImplementation(async (_tx: unknown, itemId: string) => itemId === 'has-consent');
    promoteItemOnProfileConsent.mockResolvedValue(true);
    const tx = makeSelectTx([{ item_id: 'has-consent' }, { item_id: 'no-consent' }]);
    const { promoteEligibleDraftsForUser } = await import('@/services/participant_consent');
    const n = await promoteEligibleDraftsForUser(tx as never, 'u1');
    expect(n).toBe(1);
    expect(promoteItemOnProfileConsent).toHaveBeenCalledWith(tx, 'has-consent');
    expect(promoteItemOnProfileConsent).not.toHaveBeenCalledWith(tx, 'no-consent');
  });
});
