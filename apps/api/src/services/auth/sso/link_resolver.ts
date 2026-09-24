import type { KeycloakAdminClient } from '@/services/auth/keycloak_admin';
import type { SsoIdentity, SsoResult } from '@/services/auth/sso/types';

/**
 * Decide which Keycloak account a verified partner user becomes.
 *
 * The SSO API decides and Keycloak executes: the answer is the
 * `preferred_username` put in the id_token, and the realm's first-login flow
 * auto-links on username. Because only this function sets that claim — and
 * never from partner-supplied email — linking is on the phone number alone.
 *
 * Rules (spec §6):
 *   - no account holds the number          → new account, username = the number
 *   - one account, already linked to us    → that account (returning user)
 *   - one account, linked to another user  → link-conflict
 *   - one account, not linked, verified    → link it
 *   - one account, not linked, unverified  → phone-unverified
 *   - several accounts                     → link-conflict
 *
 * The username search matters as well as the attribute search: a realm that
 * dropped the `phoneNumber` attribute (see infra/keycloak/README.md) can still
 * hold a user whose *username* is the number, and first-login would otherwise
 * auto-link to it without the verification check.
 */

type AdminLookups = Pick<
  KeycloakAdminClient,
  'findByPhone' | 'findByUsername' | 'federatedIdentities'
>;

export interface LinkResolverDeps {
  admin: AdminLookups | null;
  /** The realm's alias for the SSO identity provider. */
  idpAlias: string;
}

export async function resolveAccountLink(
  identity: SsoIdentity,
  deps: LinkResolverDeps
): Promise<SsoResult<{ preferredUsername: string }>> {
  if (!deps.admin) {
    return {
      ok: false,
      reason: 'provider-unavailable',
      detail: 'Keycloak Admin-REST client is not configured',
    };
  }
  const admin = deps.admin;

  try {
    const [byPhone, byUsername] = await Promise.all([
      admin.findByPhone(identity.phone),
      admin.findByUsername(identity.phone),
    ]);
    const candidates = [...new Map([...byPhone, ...byUsername].map((u) => [u.id, u])).values()];

    if (candidates.length === 0) {
      return { ok: true, value: { preferredUsername: identity.phone } };
    }
    if (candidates.length > 1) {
      return { ok: false, reason: 'link-conflict', detail: 'number matches several accounts' };
    }

    const account = candidates[0] as { id: string; username?: string };
    if (!account.username) {
      return { ok: false, reason: 'link-conflict', detail: 'matched account has no username' };
    }

    const links = await admin.federatedIdentities(account.id);
    const ours = links.find((l) => l.identityProvider === deps.idpAlias);
    if (ours) {
      return ours.userId === identity.subject
        ? { ok: true, value: { preferredUsername: account.username } }
        : { ok: false, reason: 'link-conflict', detail: 'account linked to another partner user' };
    }

    if (!identity.phoneVerified) {
      return { ok: false, reason: 'phone-unverified' };
    }
    return { ok: true, value: { preferredUsername: account.username } };
  } catch (err) {
    return {
      ok: false,
      reason: 'provider-unavailable',
      detail: err instanceof Error ? err.message : 'Keycloak lookup failed',
    };
  }
}
