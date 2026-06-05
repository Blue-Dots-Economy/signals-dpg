export interface DomainLockResult {
  /** True when the requested domain is allowed for this user in this network. */
  allowed: boolean;
  /**
   * The domain the user is already locked to (first distinct held domain),
   * or null when the user holds no items yet. Used only for the 403 message.
   */
  lockedDomain: string | null;
}

/**
 * A user is locked to a single domain per network: the domain of the items
 * they have already created there. The lock is derived live from the items
 * table — there is no membership column. An empty set means "not yet locked",
 * so any served domain is allowed. Deleting all of a user's items in a network
 * empties the set and releases the lock (changeable-when-empty semantics).
 *
 * `existingDomains` may contain duplicates (a provider with a profile plus
 * several job postings) — dedupe before deciding. It may, for legacy/dirty
 * rows, contain more than one distinct domain; in that case we allow any
 * already-held domain and report the first for messaging.
 */
export function resolveDomainLock(
  existingDomains: string[],
  requestedDomain: string,
): DomainLockResult {
  const distinct = [...new Set(existingDomains)];
  if (distinct.length === 0) {
    return { allowed: true, lockedDomain: null };
  }
  return {
    allowed: distinct.includes(requestedDomain),
    lockedDomain: distinct[0],
  };
}
