import { createHmac } from 'node:crypto';
import { encryptPiiBlob, decryptPiiBlob, getPiiKey } from '@dpg/auth';

/**
 * Deterministic, non-reversible ref for a guardian contact (HMAC with the PII
 * key over the trimmed, lowercased contact), so wards sharing a guardian can be
 * counted; the encrypted contact uses a random nonce and can't be matched.
 */
export function guardianRef(contact: string): string {
  const normalized = contact.trim().toLowerCase();
  return createHmac('sha256', getPiiKey()).update(normalized).digest('hex');
}

/**
 * Encrypts a guardian PII field (name / contact) for at-rest storage with the
 * shared PII key and scheme. Cleartext is never persisted.
 */
export function encryptGuardianField(plaintext: string): string {
  return encryptPiiBlob(plaintext, getPiiKey());
}

/** Decrypts a guardian PII field; use the result transiently only. */
export function decryptGuardianField(blob: string): string {
  return decryptPiiBlob(blob, getPiiKey());
}
