import { createHmac } from 'node:crypto';
import { encryptPiiBlob, decryptPiiBlob, getPiiKey } from '@dpg/auth';

/**
 * Deterministic, non-reversible reference for a guardian contact, so multiple
 * wards sharing one guardian can be counted without decrypting (the encrypted
 * contact uses a random nonce and can't be matched). HMAC-keyed with the PII
 * key. Normalizes the contact (trim + lowercase) so "+91.." / an email match
 * regardless of casing/whitespace.
 */
export function guardianRef(contact: string): string {
  const normalized = contact.trim().toLowerCase();
  return createHmac('sha256', getPiiKey()).update(normalized).digest('hex');
}

/**
 * Encrypt a guardian PII field (name / contact) for at-rest storage, reusing
 * the shared PII key + AEAD scheme (spec D5). Cleartext is never persisted.
 */
export function encryptGuardianField(plaintext: string): string {
  return encryptPiiBlob(plaintext, getPiiKey());
}

/** Decrypt a guardian PII field — used only transiently (OTP send / audited view). */
export function decryptGuardianField(blob: string): string {
  return decryptPiiBlob(blob, getPiiKey());
}
