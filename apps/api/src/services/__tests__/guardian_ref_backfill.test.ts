import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guardian rows written before guardian phones were canonicalised to E.164
 * carry a guardian_ref hashed from the raw typed phone, so the ward cap (which
 * counts by ref) misses them. The backfill re-canonicalises the stored phone
 * and recomputes the ref.
 */

const { batches, updates, updateMatches } = vi.hoisted(() => ({
  batches: [] as unknown[][],
  updates: [] as Array<{ set: Record<string, unknown> }>,
  updateMatches: { value: true },
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(batches.shift() ?? []) }),
        }),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            updates.push({ set });
            return Promise.resolve(updateMatches.value ? [{ userId: 'x' }] : []);
          },
        }),
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  minor_guardian: {
    userId: 'mg.userId',
    guardianContact: 'mg.guardianContact',
    guardianContactType: 'mg.guardianContactType',
    guardianPhone: 'mg.guardianPhone',
    guardianRef: 'mg.guardianRef',
  },
}));

vi.mock('@/services/guardian_pii', () => ({
  encryptGuardianField: (v: string) => `enc(${v})`,
  decryptGuardianField: (v: string) => {
    if (v === 'corrupt') throw new Error('bad blob');
    return v.replace(/^enc\((.*)\)$/, '$1');
  },
  guardianRef: (contact: string) => `ref:${contact.trim().toLowerCase()}`,
}));

// minor_guardian_repo is imported for canonicalGuardianPhone; stub its config deps.
vi.mock('@/config', () => ({ apiConfig: { max_wards_per_guardian: 3 } }));
vi.mock('@/services/minor', () => ({ isMinor: (age: number) => age < 18 }));

const { backfillGuardianRefs } = await import('../guardian_ref_backfill');

const legacyRow = (userId: string, raw: string) => ({
  userId,
  guardianContact: `enc(${raw})`,
  guardianPhone: `enc(${raw})`,
  guardianRef: `ref:${raw.trim().toLowerCase()}`,
});

beforeEach(() => {
  batches.length = 0;
  updates.length = 0;
  updateMatches.value = true;
});

describe('backfillGuardianRefs', () => {
  it('re-canonicalises a legacy raw phone and recomputes its ref', async () => {
    batches.push([legacyRow('w1', '98765 43210')]);

    const stats = await backfillGuardianRefs();

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({
      guardianContact: 'enc(+919876543210)',
      guardianPhone: 'enc(+919876543210)',
      guardianRef: 'ref:+919876543210',
    });
    expect(stats).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, failed: 0 });
  });

  it('is idempotent: an already-canonical row is left alone', async () => {
    batches.push([legacyRow('w1', '+919876543210')]);

    const stats = await backfillGuardianRefs();

    expect(updates).toHaveLength(0);
    expect(stats).toMatchObject({ scanned: 1, updated: 0, unchanged: 1 });
  });

  it('keeps a phone that cannot be made E.164 as its trimmed value (ref unchanged)', async () => {
    batches.push([legacyRow('w1', '12345')]);

    const stats = await backfillGuardianRefs();

    expect(updates).toHaveLength(0);
    expect(stats.unchanged).toBe(1);
  });

  it('recomputes the ref when only the guardian_phone column is non-canonical', async () => {
    batches.push([
      {
        userId: 'w1',
        guardianContact: 'enc(+919876543210)',
        guardianPhone: 'enc(9876543210)',
        guardianRef: 'ref:+919876543210',
      },
    ]);

    await backfillGuardianRefs();

    expect(updates).toHaveLength(1);
    expect(updates[0].set).toMatchObject({ guardianPhone: 'enc(+919876543210)' });
  });

  it('writes nothing on a dry run but still reports what would change', async () => {
    batches.push([legacyRow('w1', '9876543210'), legacyRow('w2', '+919876543211')]);

    const stats = await backfillGuardianRefs({ dryRun: true });

    expect(updates).toHaveLength(0);
    expect(stats).toMatchObject({ scanned: 2, updated: 1, unchanged: 1 });
  });

  it('counts an undecryptable row as failed and carries on', async () => {
    batches.push([
      { userId: 'bad', guardianContact: 'corrupt', guardianPhone: null, guardianRef: 'x' },
      legacyRow('w2', '9876543210'),
    ]);

    const stats = await backfillGuardianRefs();

    expect(stats).toMatchObject({ scanned: 2, updated: 1, failed: 1 });
  });

  it('counts a row rewritten concurrently (no match on the old blob) as skipped, not updated', async () => {
    batches.push([legacyRow('w1', '9876543210')]);
    updateMatches.value = false;

    const stats = await backfillGuardianRefs();

    expect(stats).toMatchObject({ updated: 0, raced: 1 });
  });

  it('pages through every batch', async () => {
    batches.push(
      Array.from({ length: 2 }, (_, i) => legacyRow(`a${i}`, '9876543210')),
      [legacyRow('b0', '9876543210')],
    );

    const stats = await backfillGuardianRefs({ batchSize: 2 });

    expect(stats.scanned).toBe(3);
    expect(stats.updated).toBe(3);
  });
});
