/**
 * Signup data that has nowhere to live until the account exists. Self-signup
 * creates the Keycloak identity, but the local `user` row only appears at first
 * login, so the domain and age from the signup form are parked in Redis with a
 * short TTL, keyed on the signup identifier (as `signup_guardian.ts` does).
 *
 * The Redis key is a hash of the identifier; a raw email or phone number must
 * never sit in a Redis key.
 *
 * `takeSignupExtras` deletes on read, so a stash can't be replayed onto a
 * second account.
 */

import { createHash } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/** 30 min — long enough to complete an OTP login, short enough not to linger. */
const EXTRAS_TTL_SEC = 1800;

export interface SignupExtras {
  /** Network domain the user chose to join, e.g. 'seeker'. Validated at signup. */
  domain?: string;
  /** Age in years (0..120). Drives U18 gating once it reaches `user.age`. */
  age?: number;
}

/**
 * What is stored. `keys` records every key this stash was written under, so a
 * read with only one identifier still clears the sibling copy; otherwise a
 * phone-keyed leftover could be applied to a different account using that
 * number. Hashes only.
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

/** SHA-256 hex of the normalized identifier. */
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
 * Park the signup extras. No-op when there is nothing to keep. Throws on a
 * Redis error; the caller treats it as best-effort.
 */
export async function stashSignupExtras(
  identifiers: ExtrasIdentifiers,
  extras: SignupExtras
): Promise<void> {
  if (!extras.domain && extras.age === undefined) return;

  const keys = keysFor(identifiers);
  if (keys.length === 0) return;

  const payload = JSON.stringify({ ...extras, keys } satisfies StoredExtras);
  await Promise.all(keys.map((key) => redis.set(key, payload, 'EX', EXTRAS_TTL_SEC)));
}

/**
 * Read the stash without deleting it, so it cannot race `takeSignupExtras`.
 * Used to pick the welcome copy's domain. Never throws: a miss or Redis error
 * returns null.
 */
export async function peekSignupExtras(
  identifiers: ExtrasIdentifiers
): Promise<SignupExtras | null> {
  const keys = keysFor(identifiers);
  for (const key of keys) {
    let raw: string | null = null;
    try {
      raw = await redis.get(key);
    } catch {
      return null;
    }
    if (!raw) continue;
    try {
      const { keys: _written, ...extras } = JSON.parse(raw) as StoredExtras;
      return extras;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read and delete the stash for these identifiers. Returns null when nothing is
 * parked (the normal case for a migrated or admin-onboarded user). Throws on a
 * Redis error; provisioning catches it so the login still succeeds.
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

    // Clear the keys looked up and any sibling recorded in the payload, so no
    // copy survives to be reapplied.
    const toDelete = new Set([...keys, ...(stored?.keys ?? [])]);
    await Promise.all([...toDelete].map((k) => redis.del(k)));

    if (!stored) return null;
    const { keys: _written, ...extras } = stored;
    return extras;
  }

  return null;
}
