/** Postgres unique-violation. Concurrent inserts surface as this. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when `err` is a Postgres unique-constraint violation.
 *
 * Replaces three near-copies of this predicate (`services/auth/user_writer.ts`,
 * `services/auth/provisioning.ts`, `routes/v1/admin/participant.ts`). The two
 * auth ones only read `code ?? cause.code`; the participant one also matched on
 * the message text. This keeps the **superset** — the message fallback is what
 * catches a driver that wraps the error deeply enough to lose `code`, and
 * dropping it would narrow the admin-onboarding path's race handling.
 *
 * Only these three call sites are consolidated. The inline `23505` checks on
 * the consent and item-create paths (`admin/aggregator/upsert.ts`,
 * `consent/accept_profile_consent.ts`, `item/create_item.ts`) are deliberately
 * left alone — each sits inside a wider catch with its own logging and
 * idempotency semantics.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  const pg_code = e?.code ?? e?.cause?.code;
  const message = String(e?.message ?? '');

  return (
    pg_code === PG_UNIQUE_VIOLATION ||
    message.includes('duplicate key value') ||
    message.includes('unique constraint')
  );
}
