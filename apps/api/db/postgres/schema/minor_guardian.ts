import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * U18 guardian-consent record — one row per ward, keyed on the better-auth
 * user_id (U18 spec §4). The ward's age lives on `user.age`
 * (not here); `is_minor` is DERIVED at read time (services/minor.ts), never a
 * column. guardian_name / guardian_contact hold
 * PII and are encrypted at the write path in a later phase (columns stay
 * text). Guardian approvals + the ward attestation live in `consent_record`,
 * not here.
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
