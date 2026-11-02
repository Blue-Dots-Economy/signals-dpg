import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * U18 guardian-consent record, one row per ward, keyed on the ward's user_id.
 * The ward's age lives on `user.age`; `is_minor` is derived at read time
 * (services/minor.ts). The guardian name/contact columns hold PII encrypted at
 * the write path (`minor_guardian_repo.ts`). Guardian approvals and the ward
 * attestation live in `consent_record`.
 */
export const minor_guardian = pgTable('minor_guardian', {
  userId: text('user_id').primaryKey(),
  // Age lives on `user.age`; is_minor derives from it.
  guardianName: text('guardian_name'),
  // The OTP channel actually used (phone preferred when both are given).
  guardianContact: text('guardian_contact'),
  guardianContactType: text('guardian_contact_type'), // 'phone' | 'email'
  // Both contacts the guardian supplied, stored when provided (encrypted PII).
  // guardian_contact mirrors whichever of these the OTP was sent to.
  guardianEmail: text('guardian_email'),
  guardianPhone: text('guardian_phone'),
  // Deterministic HMAC of the guardian's OTP-channel contact — lets us count
  // how many wards share one guardian (max enforced in the repo) without
  // decrypting. Non-reversible.
  guardianRef: text('guardian_ref'),
  guardianVerified: boolean('guardian_verified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('minor_guardian_guardian_ref_idx').on(table.guardianRef),
]);
