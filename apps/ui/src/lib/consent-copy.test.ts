import { describe, it, expect } from 'vitest';
import {
  renderConsentStatement,
  formatCounterpartyNoun,
  CONSENT_COUNTERPARTY_PLACEHOLDER,
} from './consent-copy';

describe('formatCounterpartyNoun', () => {
  it('uses the domain id verbatim, lowercase, underscores → spaces', () => {
    expect(formatCounterpartyNoun('provider')).toBe('provider');
    expect(formatCounterpartyNoun('seeker')).toBe('seeker');
    expect(formatCounterpartyNoun('individual_tutor_weera_counsellor')).toBe(
      'individual tutor weera counsellor',
    );
  });

  it('falls back to a neutral word when no domain is known', () => {
    expect(formatCounterpartyNoun(null)).toBe('party');
    expect(formatCounterpartyNoun(undefined)).toBe('party');
    expect(formatCounterpartyNoun('')).toBe('party');
  });
});

describe('renderConsentStatement', () => {
  const initiate = `I agree to share my contact details (name, email, phone) with this ${CONSENT_COUNTERPARTY_PLACEHOLDER} if they accept my request. The request may be cancelled at any time.`;

  it('substitutes the placeholder with the counterparty noun (initiate → target)', () => {
    expect(renderConsentStatement(initiate, 'provider')).toBe(
      'I agree to share my contact details (name, email, phone) with this provider if they accept my request. The request may be cancelled at any time.',
    );
    expect(renderConsentStatement(initiate, 'seeker')).toContain(
      'with this seeker if they accept',
    );
  });

  it('substitutes every occurrence', () => {
    const two = `${CONSENT_COUNTERPARTY_PLACEHOLDER} and ${CONSENT_COUNTERPARTY_PLACEHOLDER}`;
    expect(renderConsentStatement(two, 'provider')).toBe('provider and provider');
  });

  it('leaves a statement without the placeholder unchanged (un-migrated config)', () => {
    const legacy = 'I agree to share my contact details with this seeker / provider.';
    expect(renderConsentStatement(legacy, 'provider')).toBe(legacy);
  });

  it('returns empty/falsy statements as-is', () => {
    expect(renderConsentStatement('', 'provider')).toBe('');
  });
});
