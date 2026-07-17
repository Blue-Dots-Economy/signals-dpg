/**
 * Action-consent copy helpers.
 *
 * Action consent statements (in each network's `consent.json`) name the OTHER
 * party a user shares their contact details with — e.g. "…with this provider…".
 * That party isn't known when the config is loaded (a "connect" action can run
 * seeker→provider OR provider→seeker), so the statement ships a
 * `__COUNTERPARTY__` placeholder that the UI substitutes at render time from the
 * concrete action direction. This differs from `__SUPPORT_EMAIL__`, which is a
 * fixed value resolved once at config-load time server-side.
 *
 * - Request (initiate) popup → counterparty is the target being connected to.
 * - Accept popup → counterparty is the requester who initiated.
 */

export const CONSENT_COUNTERPARTY_PLACEHOLDER = '__COUNTERPARTY__';

/**
 * Human noun for a counterparty, derived from its domain id (per product
 * decision: use the domain id directly). Underscores become spaces and the
 * word stays lowercase so it reads naturally mid-sentence ("…with this
 * provider…"). Falls back to a neutral word when no domain is known.
 */
export function formatCounterpartyNoun(
  domainId: string | null | undefined,
): string {
  if (!domainId) return 'party';
  return domainId.replace(/_/g, ' ');
}

/**
 * Substitute `__COUNTERPARTY__` in an action-consent statement with the noun
 * for `counterpartyDomainId`. A statement without the placeholder (e.g. an
 * older, not-yet-migrated config) is returned unchanged.
 */
export function renderConsentStatement(
  statement: string,
  counterpartyDomainId: string | null | undefined,
): string {
  if (!statement) return statement;
  return statement.split(CONSENT_COUNTERPARTY_PLACEHOLDER).join(
    formatCounterpartyNoun(counterpartyDomainId),
  );
}
