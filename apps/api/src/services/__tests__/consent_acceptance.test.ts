import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: {
    id: 'consent_record.id',
    userId: 'consent_record.userId',
    level: 'consent_record.level',
    network: 'consent_record.network',
    consentCategory: 'consent_record.consentCategory',
    itemId: 'consent_record.itemId',
  },
}));

import {
  hasAcceptedTermsAndPrivacy,
  hasAcceptedProfileConsent,
} from '../consent_acceptance';

/**
 * Fake drizzle executor. `hasAcceptedTermsAndPrivacy` ends its chain at
 * `.where()`, `hasAcceptedProfileConsent` ends at `.limit()`, so the object
 * returned by `where()` is both awaitable and `.limit()`-able.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeExec(rows: unknown[]): any {
  const whereResult = {
    then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => ({ from: () => ({ where: () => whereResult }) }),
  };
}

describe('hasAcceptedTermsAndPrivacy', () => {
  it('true when BOTH terms and privacy rows exist', async () => {
    const exec = makeExec([{ category: 'terms' }, { category: 'privacy' }]);

    await expect(
      hasAcceptedTermsAndPrivacy(exec, 'u1', 'blue_dot'),
    ).resolves.toBe(true);
  });

  it('false when only terms is accepted', async () => {
    const exec = makeExec([{ category: 'terms' }]);

    await expect(
      hasAcceptedTermsAndPrivacy(exec, 'u1', 'blue_dot'),
    ).resolves.toBe(false);
  });

  it('false when only privacy is accepted', async () => {
    const exec = makeExec([{ category: 'privacy' }]);

    await expect(
      hasAcceptedTermsAndPrivacy(exec, 'u1', 'blue_dot'),
    ).resolves.toBe(false);
  });

  it('false when nothing is accepted', async () => {
    const exec = makeExec([]);

    await expect(
      hasAcceptedTermsAndPrivacy(exec, 'u1', 'blue_dot'),
    ).resolves.toBe(false);
  });

  it('tolerates duplicate rows for the same category (append-only ledger)', async () => {
    // The ledger is append-only, so re-acceptance adds rows rather than
    // replacing them; the set-based check must still resolve true.
    const exec = makeExec([
      { category: 'terms' },
      { category: 'terms' },
      { category: 'privacy' },
    ]);

    await expect(
      hasAcceptedTermsAndPrivacy(exec, 'u1', 'blue_dot'),
    ).resolves.toBe(true);
  });
});

describe('hasAcceptedProfileConsent', () => {
  it('true when a profile_creation row exists for the item', async () => {
    const exec = makeExec([{ id: 'c1' }]);

    await expect(hasAcceptedProfileConsent(exec, 'item-1')).resolves.toBe(true);
  });

  it('false when no row exists for the item', async () => {
    const exec = makeExec([]);

    await expect(hasAcceptedProfileConsent(exec, 'item-1')).resolves.toBe(
      false,
    );
  });
});
