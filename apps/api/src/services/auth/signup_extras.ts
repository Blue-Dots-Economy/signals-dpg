/**
 * Signup data that has nowhere to live until the account exists.
 *
 * Under Keycloak, self-signup creates the identity but the local `user` row only
 * appears at first successful login (see `self_signup.ts` for why). So the
 * signals-specific fields collected on the signup form — the domain the person
 * is joining, and their date of birth — have to be parked somewhere in between.
 *
 * Keyed on the signup identifier and held in Redis with a short TTL, exactly the
 * pattern the pre-auth guardian capture already uses
 * (`signup_guardian.ts`): at signup time there is no user id to key anything on,
 * so the identifier is all we have.
 *
 * **The Redis key is a hash of the identifier, never the identifier itself** —
 * a raw email or phone number must not sit in a Redis key. Same rule as
 * signup_guardian.
 *
 * Read-once: `takeSignupExtras` deletes on read, so a stash can't be replayed
 * onto a second account.
 */

import { createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/** 30 min — long enough to complete an OTP login, short enough not to linger. */
const EXTRAS_TTL_SEC = 1800;

export interface SignupExtras {
  /** Network domain the user chose to join, e.g. 'seeker'. Validated at signup. */
  domain?: string;
  /** ISO date string. Drives U18 gating once it reaches the `user` row. */
  dateOfBirth?: string;
}

/**
 * What is actually stored. `keys` records every key this stash was written under
 * so a read that arrives with only ONE identifier can still clear the sibling
 * copy — otherwise a phone-keyed leftover could later be applied to a different
 * account that happens to use that number. Hashes only; no raw identifiers.
 */
interface StoredExtras extends SignupExtras {
  keys: string[];
}

/** The identifiers a signup or a token can be keyed on. */
export interface ExtrasIdentifiers {
  email?: string | null;
  phoneNumber?: string | null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  return value.trim();
}

/** SHA-256 hex of the normalized identifier — never the raw identifier. */
function hashIdentifier(normalizedValue: string): string {
  return createHash('sha256').update(normalizedValue).digest('hex');
}

const extrasKey = (hash: string) => `signup_extras:${hash}`;

/**
 * Every key an identifier set maps to. A signup gives one identifier but a token
 * may carry both, so both are checked on the way out.
 */
function keysFor(identifiers: ExtrasIdentifiers): string[] {
  const keys: string[] = [];
  if (identifiers.email) keys.push(extrasKey(hashIdentifier(normalizeEmail(identifiers.email))));
  if (identifiers.phoneNumber) {
    keys.push(extrasKey(hashIdentifier(normalizePhone(identifiers.phoneNumber))));
  }
  return keys;
}

/**
 * Park the signup extras. No-op when there is nothing worth keeping, so callers
 * don't have to check.
 *
 * Never throws: failing to stash costs the user a domain selection they can redo
 * later, and must not fail the signup itself.
 */
export async function stashSignupExtras(
  identifiers: ExtrasIdentifiers,
  extras: SignupExtras
): Promise<void> {
  if (!extras.domain && !extras.dateOfBirth) return;

  const keys = keysFor(identifiers);
  if (keys.length === 0) return;

  const payload = JSON.stringify({ ...extras, keys } satisfies StoredExtras);
  await Promise.all(keys.map((key) => redis.set(key, payload, 'EX', EXTRAS_TTL_SEC)));
}

/**
 * Read and delete the stash for these identifiers. Returns null when there is
 * nothing parked — the normal case for a migrated or admin-onboarded user.
 *
 * Never throws: a Redis outage here must not fail a login that has otherwise
 * succeeded. The user simply lands without a domain, which is recoverable.
 */
export async function takeSignupExtras(
  identifiers: ExtrasIdentifiers
): Promise<SignupExtras | null> {
  const keys = keysFor(identifiers);
  if (keys.length === 0) return null;

  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;

    let stored: StoredExtras | null = null;
    try {
      stored = JSON.parse(raw) as StoredExtras;
    } catch {
      stored = null;
    }

    // Clear every key this stash was written under — the ones we looked up AND
    // any sibling recorded in the payload — so no copy survives to be reapplied.
    const toDelete = new Set([...keys, ...(stored?.keys ?? [])]);
    await Promise.all([...toDelete].map((k) => redis.del(k)));

    if (!stored) return null;
    const { keys: _written, ...extras } = stored;
    return extras;
  }

  return null;
}
