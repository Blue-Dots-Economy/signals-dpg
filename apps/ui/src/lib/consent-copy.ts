/**
 * Action-consent statements (in each network's `consent.json`) name the other
 * party with a `__COUNTERPARTY__` placeholder, substituted at render time
 * because a "connect" action can run in either direction. (`__SUPPORT_EMAIL__`,
 * by contrast, is resolved server-side at config load.)
 * Request popup: the counterparty is the target. Accept popup: the requester.
 */

export const CONSENT_COUNTERPARTY_PLACEHOLDER = '__COUNTERPARTY__';

/**
 * Noun for a counterparty: its domain id with underscores as spaces, lowercase
 * to read mid-sentence. Falls back to 'party' when no domain is known.
 */
export function formatCounterpartyNoun(
  domainId: string | null | undefined,
): string {
  if (!domainId) return 'party';
  return domainId.replaceAll('_', ' ');
}

/**
 * Substitutes `__COUNTERPARTY__` with `noun`. A statement without the
 * placeholder is returned unchanged.
 */
export function renderConsentStatementWithNoun(
  statement: string,
  noun: string,
): string {
  if (!statement) return statement;
  return statement.split(CONSENT_COUNTERPARTY_PLACEHOLDER).join(noun);
}

/** Substitutes `__COUNTERPARTY__` with the noun for one counterparty domain. */
export function renderConsentStatement(
  statement: string,
  counterpartyDomainId: string | null | undefined,
): string {
  return renderConsentStatementWithNoun(
    statement,
    formatCounterpartyNoun(counterpartyDomainId),
  );
}

/**
 * Counterparty noun for a bulk accept, whose selection can span several
 * requester domains: the distinct nouns joined with " / " ("seeker / provider"),
 * or the neutral fallback for an empty batch.
 */
export function formatBatchCounterpartyNoun(
  domainIds: ReadonlyArray<string | null | undefined>,
): string {
  const nouns = [
    ...new Set(domainIds.filter((d): d is string => Boolean(d))),
  ].map(formatCounterpartyNoun);
  return nouns.length > 0 ? nouns.join(' / ') : formatCounterpartyNoun(null);
}
