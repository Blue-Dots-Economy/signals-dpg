/**
 * Re-canonicalise stored guardian phones and recompute `guardian_ref`.
 *
 * `guardian_ref` is an HMAC of the guardian's OTP-channel contact, and the
 * per-guardian ward cap (`MAX_WARDS_PER_GUARDIAN`) counts wards by it. Guardian
 * phones are now canonicalised to E.164 before they are hashed and stored, but
 * rows written before that carry the raw typed phone (`98765 43210`) and a ref
 * hashed from it. A new link to the same guardian hashes `+919876543210`, does
 * not match those rows, and so the cap undercounts — it could be bypassed.
 *
 * The contact is stored encrypted (recoverable with the PII key), so each such
 * row is decrypted, canonicalised and rewritten with the ref recomputed. Email
 * rows are untouched: their ref was always the trimmed, lower-cased address.
 *
 * Idempotent: a row whose contact, phone and ref are already canonical is not
 * written. Each write is conditional on the encrypted contact being the blob
 * that was read (a random-nonce ciphertext), so a row re-linked concurrently is
 * left to the newer write rather than overwritten with stale data.
 */
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import { decryptGuardianField, encryptGuardianField, guardianRef } from '@/services/guardian_pii';
import { canonicalGuardianPhone } from '@/services/minor_guardian_repo';

const DEFAULT_BATCH_SIZE = 500;

export interface GuardianRefBackfillStats {
  scanned: number;
  /** Rewritten (or, on a dry run, that would be). */
  updated: number;
  unchanged: number;
  /** Could not be decrypted; left as is. */
  failed: number;
  /** Changed by a concurrent write between read and update; left as is. */
  raced: number;
}

interface PhoneRow {
  userId: string;
  guardianContact: string | null;
  guardianPhone: string | null;
  guardianRef: string | null;
}

/** What a row should hold once canonical, or null when it already does. */
function canonicalFields(row: PhoneRow & { guardianContact: string }) {
  const contact = decryptGuardianField(row.guardianContact);
  const canonicalContact = canonicalGuardianPhone(contact);
  const phone = row.guardianPhone ? decryptGuardianField(row.guardianPhone) : null;
  const canonicalPhone = phone === null ? null : canonicalGuardianPhone(phone);
  const ref = guardianRef(canonicalContact);

  if (canonicalContact === contact && canonicalPhone === phone && ref === row.guardianRef) {
    return null;
  }
  return {
    guardianContact:
      canonicalContact === contact ? row.guardianContact : encryptGuardianField(canonicalContact),
    guardianPhone:
      canonicalPhone === null || canonicalPhone === phone
        ? row.guardianPhone
        : encryptGuardianField(canonicalPhone),
    guardianRef: ref,
  };
}

export async function backfillGuardianRefs(
  opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<GuardianRefBackfillStats> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const stats: GuardianRefBackfillStats = { scanned: 0, updated: 0, unchanged: 0, failed: 0, raced: 0 };

  // Keyset pagination on the primary key; the update never changes it.
  let after = '';
  for (;;) {
    const rows: PhoneRow[] = await db
      .select({
        userId: minor_guardian.userId,
        guardianContact: minor_guardian.guardianContact,
        guardianPhone: minor_guardian.guardianPhone,
        guardianRef: minor_guardian.guardianRef,
      })
      .from(minor_guardian)
      .where(
        and(
          eq(minor_guardian.guardianContactType, 'phone'),
          isNotNull(minor_guardian.guardianContact),
          gt(minor_guardian.userId, after),
        ),
      )
      .orderBy(asc(minor_guardian.userId))
      .limit(batchSize);

    for (const row of rows) {
      stats.scanned++;
      const blob = row.guardianContact;
      if (!blob) continue;

      let next: ReturnType<typeof canonicalFields>;
      try {
        next = canonicalFields({ ...row, guardianContact: blob });
      } catch {
        stats.failed++;
        continue;
      }
      if (!next) {
        stats.unchanged++;
        continue;
      }
      if (dryRun) {
        stats.updated++;
        continue;
      }

      const written = await db
        .update(minor_guardian)
        .set({ ...next, updatedAt: new Date() })
        .where(and(eq(minor_guardian.userId, row.userId), eq(minor_guardian.guardianContact, blob)))
        .returning({ userId: minor_guardian.userId });
      if (written.length > 0) stats.updated++;
      else stats.raced++;
    }

    if (rows.length < batchSize) break;
    after = rows[rows.length - 1].userId;
  }

  return stats;
}
